import { defineActionModel } from '@hile/model';

let calls = 0;

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export default defineActionModel(async (input: { value: number }, invocation) => {
  await wait(25, invocation.signal);
  if (!Number.isFinite(input.value)) throw new TypeError('increment requires a finite number');
  return { buildId: 'v1', value: input.value + 1, calls: ++calls };
});
