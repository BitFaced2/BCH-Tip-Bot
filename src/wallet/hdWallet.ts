import { Wallet, TestNetWallet } from "mainnet-js";
import { withTimeout } from "../utils/withTimeout.js";
import pino from "pino";

const logger = pino({ name: "hd-wallet" });

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

  async initialize(
    mnemonic: string,
    network: "mainnet" | "testnet"
  ): Promise<void> {
    this.mnemonic = mnemonic;
    this.network = network;

    // Verify the seed is valid by deriving the hot wallet (index 0)
    await this.getWalletForIndex(0);
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

    this.walletCache.set(index, wallet);
    return wallet;
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
      const provider = (this.walletCache.get(0) as any)?.provider;
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

  private async withReconnect<T>(
    label: string,
    op: () => Promise<T>
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!this.isJamError(err)) throw err;
      logger.warn({ label }, "Electrum socket jammed — resetting and retrying");
      await this.resetElectrumConnection();
      return op();
    }
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
