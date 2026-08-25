import { defineActionModel } from '@hile/model';

export default defineActionModel(async (input: { value: number }, invocation) => {
  if (invocation.signal.aborted) throw invocation.signal.reason;
  if (!Number.isFinite(input.value)) throw new TypeError('increment requires a finite number');
  return { buildId: 'v2', value: input.value + 100 };
});
