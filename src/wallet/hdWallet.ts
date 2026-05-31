import { Wallet, TestNetWallet } from "mainnet-js";
import { withTimeout } from "../utils/withTimeout.js";

export class HDWalletManager {
  private mnemonic: string = "";
  private network: "mainnet" | "testnet" = "testnet";
  private walletCache: Map<number, Wallet> = new Map();

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

  async deriveAddress(index: number): Promise<string> {
    const wallet = await this.getWalletForIndex(index);
    return wallet.cashaddr!;
  }

  async getHotWallet(): Promise<Wallet> {
    return this.getWalletForIndex(0);
  }

  async getBalance(index: number): Promise<bigint> {
    const wallet = await this.getWalletForIndex(index);
    const balance = await withTimeout(wallet.getBalance(), 30_000, `getBalance(${index})`);
    return typeof balance === "bigint" ? balance : BigInt(Math.round(Number(balance)));
  }

  async send(
    fromIndex: number,
    toAddress: string,
    amountSatoshis: number
  ): Promise<string> {
    const wallet = await this.getWalletForIndex(fromIndex);
    const response = await withTimeout(
      wallet.send([{ cashaddr: toAddress, value: BigInt(amountSatoshis) }]),
      90_000,
      `send(${fromIndex})`
    );
    return response.txId!;
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
    const wallet = await this.getWalletForIndex(fromIndex);
    const response = await withTimeout(
      wallet.sendMax(hotWallet.cashaddr!),
      90_000,
      `sweepToHotWallet(${fromIndex})`
    );
    return response.txId!;
  }
}
