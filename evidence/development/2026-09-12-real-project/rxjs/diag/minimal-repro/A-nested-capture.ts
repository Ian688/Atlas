// Minimal reproduction of the rxjs@7.8.1 index blocker, extracted from
// rxjs/src/internal/Observable.ts:toPromise by class-member bisection.
//
// `x` is declared inside the middle arrow function and read by the inner arrow
// function. Atlas refuses the whole derivation with
//     Error: Invalid("flow_reference_unknown_binding")
// exit code 1, stdout empty.
//
// Controls (see C- and D- files) do NOT reproduce: the trigger needs a binding
// owned by a nested function and captured by a *deeper* nested function.
export function outer(f: any, g: any) {
  f(() => {
    let x = 1;
    g(() => x);
  });
}
