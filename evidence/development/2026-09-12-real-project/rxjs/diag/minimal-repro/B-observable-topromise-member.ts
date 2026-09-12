// Isolated single class member from rxjs@7.8.1 src/internal/Observable.ts
// (class-member index 29, `toPromise` implementation overload). A file holding
// this member alone still fails with flow_reference_unknown_binding (exit 1),
// and removing only this member from Observable.ts makes the file index
// successfully (exit 0), so this method is both sufficient and necessary for
// that file's failure.
export class Observable<T> {
  subscribe(a: any, b: any, c: any) {
    return [a, b, c];
  }

  toPromise(promiseCtor?: PromiseConstructorLike): Promise<T | undefined> {
    promiseCtor = getPromiseCtor(promiseCtor);

    return new promiseCtor((resolve, reject) => {
      let value: T | undefined;
      this.subscribe(
        (x: T) => (value = x),
        (err: any) => reject(err),
        () => resolve(value)
      );
    }) as Promise<T | undefined>;
  }
}

declare function getPromiseCtor(promiseCtor: PromiseConstructorLike | undefined): any;
