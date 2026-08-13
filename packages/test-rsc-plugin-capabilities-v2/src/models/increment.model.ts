import { defineActionModel, getModelExecutionContext } from '@hile/model';

export default defineActionModel(async (input: { value: number }) => {
  const signal = getModelExecutionContext()?.signal;
  if (signal?.aborted) throw signal.reason;
  if (!Number.isFinite(input.value)) throw new TypeError('increment requires a finite number');
  return { buildId: 'v2', value: input.value + 100 };
});
