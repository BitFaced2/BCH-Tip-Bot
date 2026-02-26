const CASHADDR_REGEX = /^bitcoincash:[qp][a-z0-9]{41}$/i;
const SHORT_ADDR_REGEX = /^[qp][a-z0-9]{41}$/i;

export function isValidCashAddress(address: string): boolean {
  return CASHADDR_REGEX.test(address) || SHORT_ADDR_REGEX.test(address);
}

export function normalizeCashAddress(address: string): string {
  if (SHORT_ADDR_REGEX.test(address)) {
    return `bitcoincash:${address}`;
  }
  return address;
}

export function isValidAmount(amount: string): boolean {
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) return false;

  // Max 8 decimal places
  const parts = amount.split(".");
  if (parts.length === 2 && parts[1].length > 8) return false;

  return true;
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{1,15}$/.test(username);
}
