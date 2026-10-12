/** 外部から resolve / reject できる Promise（Excalidraw の initialData に渡す） */
export type ResolvablePromise<T> = Promise<T> & {
  resolve: [T] extends [undefined] ? (value?: T) => void : (value: T) => void;
  reject: (error: Error) => void;
};

export const resolvablePromise = <T>(): ResolvablePromise<T> => {
  let resolve!: any;
  let reject!: any;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  (promise as any).resolve = resolve;
  (promise as any).reject = reject;
  return promise as ResolvablePromise<T>;
};
