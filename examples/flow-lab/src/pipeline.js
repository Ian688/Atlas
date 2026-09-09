function fastPath() {
  return 'fast';
}

function slowPath() {
  return 'slow';
}

export function branchPick(flag) {
  let pick = fastPath;
  if (flag) {
    pick = slowPath;
  }
  return pick();
}

export function strongUpdate() {
  let pick = fastPath;
  pick = slowPath;
  return pick();
}

export function identity(value) {
  return value;
}

export function indirect() {
  return identity(41);
}

export function withFinally(user) {
  let name = 'a';
  try {
    name = user;
  } finally {
  }
  return name;
}

export function finallyOverrides() {
  try {
    return 1;
  } finally {
    return 2;
  }
}

export function countdown(n) {
  let total = 0;
  while (n > 0) {
    total = total + n;
    n = n - 1;
  }
  return total;
}

export function shortCircuit(effect) {
  const never = false && effect();
  const always = 'x' ?? effect();
  return never ?? always;
}

export function divider(left, right) {
  if (right === 0) {
    throw new Error('division by zero');
  }
  return left / right;
}

export function loopCallers(handlers) {
  for (const handler of handlers) {
    handler();
  }
}

export function externalSink(callback, payload) {
  return externalApi({ from: payload }, callback);
}

export function optionalCatch() {
  try {
    throw 7;
  } catch {
    return 7;
  }
}

export function rethrow() {
  try {
    try {
      throw 1;
    } catch {
      throw 2;
    }
  } catch (e2) {
    return e2;
  }
}
