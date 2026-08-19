import {
  Wallet,
  TestNetWallet,
  getNetworkProvider,
  DefaultProvider,
  Network,
} from "mainnet-js";
import { withTimeout } from "../utils/withTimeout.js";
import pino from "pino";

const logger = pino({ name: "hd-wallet" });

// mainnet-js 3.x ships exactly ONE default Electrum server (the rest are
// commented out in its source) and only ever connects to servers[0] — no
// cluster, no failover. That single volunteer-run server degraded for hours
// on 2026-08-18 and again on 2026-08-19, taking the bot's whole on-chain
// layer with it. We rotate through this list ourselves when a server stops
// answering. Order = latency measured 2026-08-19; ELECTRUM_SERVERS in .env
// overrides (comma-separated wss:// URLs).
const MAINNET_SERVERS = process.env.ELECTRUM_SERVERS
  ? process.env.ELECTRUM_SERVERS.split(",").map((s) => s.trim())
  : [
      "wss://blackie.c3-soft.com:50004",
      "wss://bch.imaginary.cash:50004",
      "wss://electrum.imaginary.cash:50004",
    ];

// Rotate after this many consecutive failed wallet operations (any error
// kind — jams, timeouts, refusals). Any success resets the count.
const ROTATE_AFTER_FAILURES = 5;

// @electrum-cash/web-socket occasionally strands a dead socket handle: the
// client believes a connection exists, so every subsequent connect() throws
// this error and the state never self-heals (observed 2026-07-15, 07-28,
// 08-15 — roughly fortnightly). The error is thrown synchronously from the
// connect phase, which strictly precedes request transmission (verified
// against mainnet-js 3.1.7: performRequest awaits connect() before
// electrum.request(), and a disconnected client rejects requests with a
// different message before connection.send). A request that fails with THIS
// message therefore provably never reached the network, so resetting the
// socket and retrying once is safe — even for transaction broadcasts.
const ELECTRUM_JAM_MESSAGE = "Cannot initiate a new socket connection";

export class HDWalletManager {
  private mnemonic: string = "";
  private network: "mainnet" | "testnet" = "testnet";
  private walletCache: Map<number, Wallet> = new Map();
  private resetting: Promise<void> | null = null;
  private serverIndex = 0;
  private consecutiveFailures = 0;
  private provider: any = null;

  async initialize(
    mnemonic: string,
    network: "mainnet" | "testnet"
  ): Promise<void> {
    this.mnemonic = mnemonic;
    this.network = network;

    if (network === "mainnet") {
      this.provider = this.buildProvider();
      logger.info(
        { server: MAINNET_SERVERS[this.serverIndex] },
        "Electrum provider initialized"
      );
    }

    // Verify the seed is valid by deriving the hot wallet (index 0)
    await this.getWalletForIndex(0);
  }

  // A dedicated (non-global) provider pinned to our current server choice.
  // Also mirror the choice into DefaultProvider so any mainnet-js code path
  // that consults the global default resolves to the same server.
  private buildProvider(): any {
    const server = MAINNET_SERVERS[this.serverIndex];
    DefaultProvider.servers.mainnet = [server];
    return getNetworkProvider(Network.MAINNET, server);
  }

  private derivationPath(index: number): string {
    return `m/44'/145'/0'/0/${index}`;
  }

  async getWalletForIndex(index: number): Promise<Wallet> {
    const cached = this.walletCache.get(index);
    if (cached) return cached;

    const WalletClass =
      this.network === "mainnet" ? Wallet : TestNetWallet;

    const wallet = await WalletClass.fromSeed(
      this.mnemonic,
      this.derivationPath(index)
    );

    // Pin the wallet to our rotating provider (seed derivation itself is
    // pure local math — no network I/O happens before this swap).
    if (this.provider) {
      (wallet as any).provider = this.provider;
    }

    this.walletCache.set(index, wallet);
    return wallet;
  }

  // Sustained failures mean the server is degraded (2026-08-18/19: hours of
  // timeouts on the library's single default server) — move to the next one.
  // Old provider is torn down best-effort; wallets rebuild lazily on the new
  // provider via the cleared cache.
  private rotateServer(): void {
    const from = MAINNET_SERVERS[this.serverIndex];
    this.serverIndex = (this.serverIndex + 1) % MAINNET_SERVERS.length;
    this.consecutiveFailures = 0;

    const oldProvider = this.provider;
    if (oldProvider) {
      withTimeout(oldProvider.disconnect(), 10_000, "rotate disconnect").catch(
        () => {}
      );
    }
    this.provider = this.buildProvider();
    this.walletCache.clear();
    logger.warn(
      { from, to: MAINNET_SERVERS[this.serverIndex] },
      "Rotated Electrum server after sustained failures"
    );
  }

  private isJamError(err: unknown): boolean {
    return err instanceof Error && err.message.includes(ELECTRUM_JAM_MESSAGE);
  }

  // All wallets share one global network provider, so healing it once heals
  // every wallet in the cache. disconnect() clears the stranded socket handle
  // even from the jammed state (its finally block always nulls the handle);
  // the follow-up connect() is best-effort since every request reconnects on
  // demand anyway.
  private resetElectrumConnection(): Promise<void> {
    // The deposit monitor fans out over many users, so a jam surfaces as a
    // burst of concurrent failures — serialize so they share one reset.
    if (this.resetting) return this.resetting;
    this.resetting = (async () => {
      const provider =
        this.provider ?? (this.walletCache.get(0) as any)?.provider;
      // Both teardown and reconnect are time-boxed: during the 2026-08-18
      // upstream outage a reset took 2 minutes, and an unresolving
      // disconnect() here would wedge every withReconnect caller behind the
      // shared resetting promise.
      try {
        await withTimeout(provider?.disconnect() ?? Promise.resolve(), 10_000, "electrum reset disconnect");
      } catch {
        // Tearing down a jammed provider may itself throw; the socket handle
        // is cleared regardless.
      }
      try {
        await withTimeout(provider?.connect() ?? Promise.resolve(), 10_000, "electrum reset connect");
      } catch {
        // Leave reconnection to the next request if the server is unreachable.
      }
      logger.warn("Electrum connection reset after socket jam");
    })().finally(() => {
      this.resetting = null;
    });
    return this.resetting;
  }

  private noteFailure(): void {
    this.consecutiveFailures++;
    if (
      this.network === "mainnet" &&
      this.consecutiveFailures >= ROTATE_AFTER_FAILURES
    ) {
      this.rotateServer();
    }
  }

  private async withReconnect<T>(
    label: string,
    op: () => Promise<T>
  ): Promise<T> {
    let result: T;
    try {
      result = await op();
    } catch (err) {
      this.noteFailure();
      if (!this.isJamError(err)) throw err;
      logger.warn({ label }, "Electrum socket jammed — resetting and retrying");
      await this.resetElectrumConnection();
      try {
        result = await op();
      } catch (retryErr) {
        this.noteFailure();
        throw retryErr;
      }
    }
    this.consecutiveFailures = 0;
    return result;
  }

  async deriveAddress(index: number): Promise<string> {
    const wallet = await this.getWalletForIndex(index);
    return wallet.cashaddr!;
  }

  async getHotWallet(): Promise<Wallet> {
    return this.getWalletForIndex(0);
  }

  async getBalance(index: number): Promise<bigint> {
    return this.withReconnect(`getBalance(${index})`, async () => {
      const wallet = await this.getWalletForIndex(index);
      const balance = await withTimeout(wallet.getBalance(), 30_000, `getBalance(${index})`);
      return typeof balance === "bigint" ? balance : BigInt(Math.round(Number(balance)));
    });
  }

  async send(
    fromIndex: number,
    toAddress: string,
    amountSatoshis: number
  ): Promise<string> {
    // Retried ONLY on the jam error, which is provably pre-transmission (see
    // ELECTRUM_JAM_MESSAGE above). Every other failure keeps single-attempt
    // semantics: it may have broadcast, so it goes to manual review upstream.
    return this.withReconnect(`send(${fromIndex})`, async () => {
      const wallet = await this.getWalletForIndex(fromIndex);
      const response = await withTimeout(
        wallet.send([{ cashaddr: toAddress, value: BigInt(amountSatoshis) }]),
        90_000,
        `send(${fromIndex})`
      );
      return response.txId!;
    });
  }

  async sendFromHotWallet(
    toAddress: string,
    amountSatoshis: number
  ): Promise<string> {
    return this.send(0, toAddress, amountSatoshis);
  }

  async sweepToHotWallet(fromIndex: number): Promise<string | null> {
    const balance = await this.getBalance(fromIndex);
    if (balance <= BigInt(546)) return null; // dust threshold

    const hotWallet = await this.getHotWallet();
    return this.withReconnect(`sweepToHotWallet(${fromIndex})`, async () => {
      const wallet = await this.getWalletForIndex(fromIndex);
      const response = await withTimeout(
        wallet.sendMax(hotWallet.cashaddr!),
        90_000,
        `sweepToHotWallet(${fromIndex})`
      );
      return response.txId!;
    });
  }
}
