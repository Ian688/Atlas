import assert from 'node:assert/strict';
import { calculate } from './src/calculator.js';

assert.equal(calculate('12', '+', '30'), 42);
assert.equal(calculate('12', '-', '3'), 9);
assert.equal(calculate('12', '/', '3'), 4);
assert.throws(() => calculate('1', '/', '0'), /Division by zero/);
assert.throws(() => calculate('', '+', '2'), /empty/);
assert.throws(() => calculate('NaN', '+', '2'), /finite/);
console.log('PASS: 6 calculator assertions; not an Atlas execution trace');
