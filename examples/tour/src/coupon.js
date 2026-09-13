import { write } from './ledger.js';
import { dispatch } from './dispatch.js';

const MAX_DISCOUNT = 500;

export function validate(coupon, order) {
  if (!coupon || !order) {
    return false;
  }
  if (coupon.used) {
    return false;
  }
  return coupon.amount <= MAX_DISCOUNT;
}

export function redeem(coupon, order) {
  if (!validate(coupon, order)) {
    return { ok: false, reason: 'invalid' };
  }
  let written = 0;
  for (const item of order.items) {
    written = write(coupon.account, item.amount);
  }
  const receipt = dispatch('refund', order);
  return { ok: true, written, receipt };
}

export function sumDiscounts(coupons) {
  let total = 0;
  for (const coupon of coupons) {
    total = total + coupon.amount;
  }
  return total;
}
