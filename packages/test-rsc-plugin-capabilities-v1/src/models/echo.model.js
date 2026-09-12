import { defineActionModel } from '@hile/model';
export default defineActionModel(async (input) => ({
    buildId: 'v1',
    input,
}));
