// 账本：一个会写外部状态的函数，和一个可以被独立运行的纯函数。
const entries = [];

export function write(account, amount) {
  if (typeof amount !== 'number' || amount <= 0) {
    throw new Error('ledger: amount must be positive');
  }
  entries.push({ account, amount });
  return entries.length;
}

export function total() {
  return entries.reduce((sum, entry) => sum + entry.amount, 0);
}

export function onlyPositive(values) {
  return values.filter((value) => value > 0);
}
