import { redeem, sumDiscounts } from './coupon.js';

export function handleCheckout(cart, coupons) {
  const budget = sumDiscounts(coupons);
  const result = redeem(coupons[0], cart);
  return { budget, result };
}
