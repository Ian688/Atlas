// Control for A-nested-capture.ts: the binding is declared AND read inside the
// same arrow function. This indexes successfully (exit 0).
export function outer(f: any) {
  f(() => {
    let x = 1;
    return x;
  });
}
