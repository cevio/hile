'use server';

import { defineRscServerFunction } from '@hile/rsc/plugin';

export const incrementWithServerFunction = defineRscServerFunction(async (
  api,
  _previous: { buildId: string; value: number; invoked: boolean },
  formData: FormData,
) => {
  const value = Number(formData.get('value'));
  if (!Number.isFinite(value)) throw new TypeError('value must be a finite number');
  const result = await api.invokeModel('increment', { value }) as { buildId: string; value: number };
  return { ...result, invoked: true };
});
