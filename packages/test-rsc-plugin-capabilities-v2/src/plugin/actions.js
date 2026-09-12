'use server';
import { defineRscServerFunction } from '@hile/rsc/plugin';
export const incrementWithServerFunction = defineRscServerFunction(async (api, _previous, formData) => {
    const value = Number(formData.get('value'));
    if (!Number.isFinite(value))
        throw new TypeError('value must be a finite number');
    const result = await api.invokeModel('increment', { value });
    return { ...result, invoked: true };
});
