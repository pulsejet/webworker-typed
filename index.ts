/**
 * Data sent from main thread to worker.
 */
type CommRequest = {
    reqid: number;
    name: string;
    args: unknown[];
};

/**
 * Data sent from worker to main thread.
 */
type CommResult = {
    reqid: number;
    resolve?: unknown;
    reject?: string;
};

/**
 * Map of function names to functions.
 */
type FunctionMap = { [name: string]: Function; };

/**
 * Utility type to convert all methods in an object to async.
 */
type Async<T extends FunctionMap> = {
    [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R>
    : T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : T[K];
};

/**
 * Type to mark an object as transferred.
 * 
 * @example
 * ```ts
 * // mywoker.ts
 * function foo(buffer: Transferred<ArrayBuffer>) {
 *  // buffer is transferred
 * }
 */
export type Transferred<T> = T & { _Is_Transferred_: true; };

/**
 * Mark an object as transferred.
 *
 * @param e Object to transfer
 * 
 * @example
 * ```ts
 * // main.ts
 * worker.foo(transfer(new ArrayBuffer(1000)));
 */
export function transfer<T extends Object>(e: T): Transferred<T> {
    if (typeof e === 'object') {
        // @ts-ignore
        e._Is_Transferred_ = true;
        console.log(e);
    }
    return e as Transferred<T>;
}

/**
 * Export methods from a worker to the main thread.
 *
 * @param handlers Object with methods to export
 *
 * @example
 * ```ts
 * // my-worker.ts
 * function foo() { return 'bar'; }
 *
 * async function asyncFoo() { return 'bar'; }
 *
 * export default exportWorker({
 *   foo,
 *   asyncFoo,
 *   inline: () => 'bar',
 * });
 * ```
 */
export function exportWorker<T extends FunctionMap>(handlers: T): Async<T> {
    self.onmessage = async ({ data }: { data: CommRequest; }) => {
        try {
            // Get handler from registrations
            const handler = handlers[data.name];
            if (!handler) throw new Error(`[BUG] No handler for type ${data.name}`);

            // Run handler
            let result = handler.apply(self, data.args);
            if (result instanceof Promise) {
                result = await result;
            }

            // Success - post back to main thread
            self.postMessage({ reqid: data.reqid, resolve: result } as CommResult);
        } catch (e: any) {
            // Error - post back rejection
            self.postMessage({ reqid: data.reqid, reject: e.message } as CommResult);
        }
    };

    return null as unknown as Async<T>;
}

/**
 * Import a worker exported with `exportWorker`.
 *
 * @param worker Worker to import
 *
 * @example
 * ```ts
 * // main.ts
 * import type MyWorker from './my-worker.ts';
 *
 * const worker = importWorker<typeof MyWorker>(new Worker(new URL('./XImgWorkerStub.ts', import.meta.url)));
 *
 * (async () => {
 *   // all methods are async
 *   console.assert(await worker.foo() === 'bar');
 *   console.assert(await worker.asyncFoo() === 'bar');
 *   console.assert(await worker.inline() === 'bar');
 * })();
 * ```
 */
export function importWorker<T>(worker: Worker) {
    const promises = new Map<number, { resolve: Function; reject: Function; }>();

    // Handle messages from worker
    worker.onmessage = ({ data }: { data: CommResult; }) => {
        const { reqid, resolve, reject } = data;
        if (resolve) promises.get(reqid)?.resolve(resolve);
        if (reject) promises.get(reqid)?.reject(reject);
        promises.delete(reqid);
    };

    // Create proxy to call worker methods
    const proxy = new Proxy(worker, {
        get(target: Worker, name: string) {
            return async function wrapper(...args: any[]) {
                return await new Promise((resolve, reject) => {
                    const reqid = Math.random();
                    promises.set(reqid, { resolve, reject });
                    target.postMessage({ reqid, name, args } as CommRequest, args.filter(e => e?._Is_Transferred_));
                });
            };
        },
    });

    return proxy as T;
}
