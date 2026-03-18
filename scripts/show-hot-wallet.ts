import "dotenv/config";
import { Wallet, TestNetWallet } from "mainnet-js";

async function main() {
  const mnemonic = process.env.MASTER_SEED_MNEMONIC!;
  const network = process.env.BCH_NETWORK || "mainnet";

  const WalletClass = network === "mainnet" ? Wallet : TestNetWallet;
  const wallet = await WalletClass.fromSeed(mnemonic, "m/44'/145'/0'/0/0");

  console.log(`Network:     ${network}`);
  console.log(`Hot wallet:  ${wallet.cashaddr}`);

  const balance = await wallet.getBalance();
  console.log(`Balance:     ${balance} satoshis`);
}

main();
