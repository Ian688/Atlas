
function setValue(o) { o.value = 2; }
function one() { return 1; }
function identity(x) { return x; }
export function knownMutation() { const o = {value: 1}; setValue(o); return o.value; }
export function unknownMutation(change) { const o = {value: 1}; change(o); return o.value; }
export function mixedAddition() { return true + 1; }
export function nullAddition() { return null + 1; }
export function missingField(flag) { const o = flag ? {value: 1} : {}; return o.value; }
export function viaIdentity() { const f = identity(one); return f(); }
export function identityNumber() { return identity(41); }
export function captureChange() { function f() { return 1; } function inner() { return f(); } f = () => 2; return inner(); }
export function increment() { let x = 1; const previous = x++; return previous; }
export function finallyReturn() { try { return 1; } finally { const x = 2; } return 9; }
export function throwCatch() { function fail() { throw 7; } try { fail(); return 1; } catch (e) { return e; } }
export function exceptionState(change) { let x = 1; try { change(); x = 2; } catch (e) { return x; } return x; }
