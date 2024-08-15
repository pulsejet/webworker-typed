/**
 * Data sent from main thread to worker.
 */
type CommRequest = {
    isRequest: true;
    reqid: number;
    name: string;
    args: unknown[];
};

/**
 * Data sent from worker to main thread.
 */
type CommResult = {
    isRequest: false;
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


// Key to mark an function as transferred
const TRANSFERRED_FUNCTION_KEY = "_wwt_is_transferred_function_";
// Timeout for cleaning up old functions
const TEMP_FUNCTION_CG = 30 * 1000;
const TEMP_NAME_PREFIX = 'temp_fn_';

// 深度获取全部可转移的对象，跳过重复引用
const getTransferableObjects = (object: unknown, seen = new WeakSet()): Transferable[] => {
    if (typeof object !== 'object' || object === null || seen.has(object)) return [];
    seen.add(object);
    if (object instanceof Array) return object.flatMap(item => getTransferableObjects(item, seen));
    if (object instanceof OffscreenCanvas
        || object instanceof ImageBitmap
        || object instanceof MessagePort
        || object instanceof ReadableStream
        || object instanceof WritableStream
        || object instanceof TransformStream
        || object instanceof VideoFrame
        || object instanceof ArrayBuffer
    ) return [object];
    return Object.values(object).flatMap(value => getTransferableObjects(value, seen));
};


const fn2obj = (fn: Function, handlers: Map<string, Function>) => {
    const name = TEMP_NAME_PREFIX + Math.random().toString(32).slice(2);
    handlers.set(name, fn);
    return { [TRANSFERRED_FUNCTION_KEY]: true, name };
};

// 代理消息处理，统一处理消息
const messageHandler = (thread: Worker | Window & typeof globalThis,
    handlers = new Map<string, Function>(),
    promises = new Map<number, { resolve: Function; reject: Function; }>(),
    cg = new WeakMap<Function, number>()
) => {

    // 尝试还原函数
    const tryObj2fn = (obj: any) => {
        if (typeof obj === 'object' && obj[TRANSFERRED_FUNCTION_KEY] === true) {
            return (...args: unknown[]) => {
                return new Promise((resolve, reject) => {
                    const reqid = Math.random();
                    thread.postMessage({
                        isRequest: true,
                        reqid, name: obj.name,
                        args: args.map((arg) => typeof arg === 'function' ? fn2obj(arg, handlers) : arg)
                    } as CommRequest, {
                        transfer: getTransferableObjects(args)
                    });
                    promises.set(reqid, { resolve, reject });
                });
            };
        }
        return obj;
    };
    let cgCdlieId: number;
    return async ({ data }: { data: CommRequest | CommResult; }) => {
        console.log('messageHandler', data);
        if (data.isRequest) {
            try {
                const handler = handlers.get(data.name);
                if (!handler) throw new Error(`[BUG] No handler for type ${data.name}`);

                cg.has(handler) && cg.set(handler, Date.now());

                // Run handler
                let result = handler(...data.args.map((arg: unknown) => {
                    // @ts-ignore
                    if (typeof arg === 'object' && arg[TRANSFERRED_FUNCTION_KEY] === true) {
                        const { name } = arg as { name: string;[TRANSFERRED_FUNCTION_KEY]: true; };
                        return async function wrapper(...args: unknown[]) {
                            return await new Promise((resolve, reject) => {
                                const reqid = Math.random();
                                promises.set(reqid, { resolve, reject });
                                thread.postMessage({ isRequest: true, reqid, name, args: args.map(tryObj2fn) } as CommRequest, {
                                    transfer: getTransferableObjects(args)
                                });
                            });
                        };
                    }
                    return arg;
                }));

                if (result instanceof Promise) {
                    result = await result;
                }

                // 此处继续增加筛选可以继续转发函数但是会导致性能问题，要啥自行车

                // Success - post back to main thread
                thread.postMessage({ isRequest: false, reqid: data.reqid, resolve: result } as CommResult, {
                    // Auto try transfer objects
                    transfer: getTransferableObjects(result)
                });
            } catch (e: any) {
                thread.postMessage({ isRequest: false, reqid: data.reqid, reject: e.message } as CommResult);
            }
        } else {
            const { reqid, resolve, reject } = data;
            if (resolve) promises.get(reqid)?.resolve(resolve);
            if (reject) promises.get(reqid)?.reject(reject);
            promises.delete(reqid);
        }

        clearTimeout(cgCdlieId);
        // 节流遍历
        cgCdlieId = setTimeout(() => {
            // 遍历获得全部
            for (const [name, fn] of handlers) {
                if (!name.startsWith(TEMP_NAME_PREFIX)) continue;
                const now = Date.now();
                if (!cg.has(fn)) {
                    cg.set(fn, now);
                    continue;
                }
                if (now - cg.get(fn)! > TEMP_FUNCTION_CG) {
                    handlers.delete(name);
                }
            }
        }, 50);
    };
};

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
    const handler = new Map(Object.entries(handlers));

    self.onmessage = messageHandler(self, handler);
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
    const handlers = new Map<string, Function>();
    const cg = new WeakMap<Function, number>();

    // Handle messages from worker
    worker.onmessage = messageHandler(worker, handlers, promises, cg);

    // Create proxy to call worker methods
    const proxy = new Proxy(worker, {
        get(target: Worker, name: string) {
            return async function wrapper(...args: any[]) {
                return await new Promise((resolve, reject) => {
                    const reqid = Math.random();
                    promises.set(reqid, { resolve, reject });
                    target.postMessage({
                        isRequest: true,
                        reqid, name, args: args.map((arg) => typeof arg === 'function' ? fn2obj(arg, handlers) : arg)
                    } as CommRequest, {
                        transfer: getTransferableObjects(args)
                    });
                });
            };
        },
    });

    return proxy as T;
}

