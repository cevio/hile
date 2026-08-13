import { defineActionModel } from '@hile/model';

export default defineActionModel(async (input: Record<string, unknown>) => ({
  buildId: 'v1',
  input,
}));
