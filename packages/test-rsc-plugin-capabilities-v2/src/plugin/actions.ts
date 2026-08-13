'use server';

import { invokeRscModel } from '@hile/rsc/plugin';

export async function incrementWithServerFunction(
  _previous: { buildId: string; value: number; invoked: boolean },
  formData: FormData,
) {
  const value = Number(formData.get('value'));
  if (!Number.isFinite(value)) throw new TypeError('value must be a finite number');
  const result = await invokeRscModel('increment', { value }) as { buildId: string; value: number };
  return { ...result, invoked: true };
}
