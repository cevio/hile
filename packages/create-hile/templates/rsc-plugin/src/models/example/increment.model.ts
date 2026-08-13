import { defineActionModel } from '@hile/model';

export default defineActionModel(async (input: { value: number }) => {
  if (!Number.isFinite(input.value)) throw new TypeError('value must be finite');
  return { value: input.value + 1 };
});
