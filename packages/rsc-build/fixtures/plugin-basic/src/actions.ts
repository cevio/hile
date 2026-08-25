'use server';

import { defineRscServerFunction } from '@hile/rsc/plugin';

const implementationMarker = 'server-function-implementation-marker';

export const add = defineRscServerFunction(async (_api, value: number): Promise<{ value: number; marker: string }> => {
  return { value: value + 1, marker: implementationMarker };
});

export default defineRscServerFunction(async (): Promise<string> => {
  return implementationMarker;
});
