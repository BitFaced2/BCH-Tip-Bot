import { Wallet } from "mainnet-js";

async function main() {
  const w = await Wallet.newRandom();
  console.log("\n=== YOUR NEW SEED PHRASE ===");
  console.log(w.mnemonic);
  console.log("============================\n");
  console.log("IMPORTANT: Write this down and store it securely offline.");
  console.log("This seed controls all user funds. If lost, funds are unrecoverable.\n");
}

main();
