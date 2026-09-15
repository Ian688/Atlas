// 金额计算：以整数分值运算，避免浮点误差。
export function charge(amount: number, rate: number): number {
  return Math.round(amount * (1 - rate));
}

// 把折扣率收敛到 [0,1]。
export function clampRate(rate: number): number {
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}
