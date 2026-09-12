// Control for A-nested-capture.ts: the binding is declared in the OUTERMOST
// function and captured by a nested arrow. This indexes successfully (exit 0),
// so the defect is specifically about a binding owned by an intermediate
// nested function and read from a deeper nested function.
export function outer(f: any) {
  let x = 1;
  f(() => {
    return () => x;
  });
}
