const SATOSHIS_PER_BCH = 100_000_000;

export function bchToSatoshis(bch: number): number {
  return Math.round(bch * SATOSHIS_PER_BCH);
}

export function satoshisToBch(satoshis: number): number {
  return satoshis / SATOSHIS_PER_BCH;
}

export function formatBch(satoshis: number): string {
  return satoshisToBch(satoshis).toFixed(8);
}
