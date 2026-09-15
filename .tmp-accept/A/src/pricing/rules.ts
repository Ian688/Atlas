import { clampRate } from './money';

export function discounted(amount: number, rate: number): number {
  const safe = clampRate(rate);
  return amount - amount * safe;
}
