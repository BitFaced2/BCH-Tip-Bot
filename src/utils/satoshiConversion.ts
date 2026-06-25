const SATOSHIS_PER_BCH = 100_000_000;

export function bchToSatoshis(bch: number): number {
  return Math.round(bch * SATOSHIS_PER_BCH);
}

export function satoshisToBch(satoshis: number): number {
  return satoshis / SATOSHIS_PER_BCH;
}

export function formatBch(satoshis: number): string {
  // Strip trailing zeros after the decimal so "0.00100000" reads as "0.001".
  // Keep at least one decimal digit, so whole-BCH values render as "1.0" not "1".
  return satoshisToBch(satoshis)
    .toFixed(8)
    .replace(/0+$/, "")
    .replace(/\.$/, ".0");
}
