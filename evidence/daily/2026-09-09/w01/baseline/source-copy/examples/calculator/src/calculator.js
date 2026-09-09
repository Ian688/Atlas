import { parseInput } from './input.js';
import { evaluate } from './math.js';

export function calculate(leftText, operator, rightText) {
  const left = parseInput(leftText);
  const right = parseInput(rightText);
  return evaluate(operator, left, right);
}
