// 分派：这里的调用**解析不出来**，Atlas 会如实说"未解析"，而不是猜一个目标。
const handlers = {
  refund: (order) => ({ order, kind: 'refund' }),
  void: (order) => ({ order, kind: 'void' }),
};

export function dispatch(type, order) {
  const handler = handlers[type];
  if (!handler) {
    return null;
  }
  return handler(order);
}
