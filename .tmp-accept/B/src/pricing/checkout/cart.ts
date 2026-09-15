import { discounted } from '../rules';

export function total(items: number[], rate: number): number {
  let sum = 0;
  for (const item of items) sum += item;
  return discounted(sum, rate);
}
