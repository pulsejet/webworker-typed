# webworker-typed

Dead simple type-safe Web Workers.

## Installation

```bash
npm install webworker-typed
```

## Usage

Create a worker file and export the functions you want to expose:

```ts
// my-worker.ts
import { exportWorker } from 'webworker-typed';

function foo() { return 'bar'; }

async function asyncFoo() { return 'bar'; }

export default exportWorker({
  foo,
  asyncFoo,
  inline: () => 'bar',
});
```

From your main thread, import the worker and call the functions:

```ts
// main.ts
import { importWorker } from 'webworker-typed';
import type MyWorker from './my-worker.ts';

const worker = importWorker<typeof MyWorker>(new Worker(new URL('./XImgWorkerStub.ts', import.meta.url)));

async (() => {
  // all imported methods are async
  console.assert(await worker.foo() === 'bar');
  console.assert(await worker.asyncFoo() === 'bar');
  console.assert(await worker.inline() === 'bar');
});
```

## License

This project is licensed under the MIT License.