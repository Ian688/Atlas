export function add(left, right) { return left + right; }
export function subtract(left, right) { return left - right; }
export function divide(left, right) {
  if (right === 0) throw new Error('Division by zero');
  return left / right;
}

export function evaluate(operator, left, right) {
  switch (operator) {
    case '+': return add(left, right);
    case '-': return subtract(left, right);
    case '/': return divide(left, right);
    default: throw new Error('Unsupported operator');
  }
}
