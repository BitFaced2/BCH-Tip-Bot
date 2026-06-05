// Self-contained validation for web form inputs. Kept in the web tree so
// nothing leaks across the bot/web boundary; rules are short enough that
// duplicating a few regexes is cheaper than a shared module.

const CASH_ADDR_RE = /^(bitcoincash:)?[qp][a-z0-9]{38,90}$/i;
const AMOUNT_RE = /^\d+(\.\d{1,8})?$/;

export function isValidCashAddress(address: string): boolean {
  return CASH_ADDR_RE.test(address.trim());
}

export function normalizeCashAddress(address: string): string {
  const trimmed = address.trim();
  return trimmed.toLowerCase().startsWith("bitcoincash:")
    ? trimmed.toLowerCase()
    : `bitcoincash:${trimmed.toLowerCase()}`;
}

export function isValidAmount(amount: string): boolean {
  return AMOUNT_RE.test(amount.trim());
}

export function bchToSatoshis(bch: number): number {
  return Math.round(bch * 1e8);
}
