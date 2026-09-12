import { defineActionModel } from '@hile/model';
export default defineActionModel(async (input, invocation) => {
    if (invocation.signal.aborted)
        throw invocation.signal.reason;
    return { pluginId: 'demo.rsc.isolation', buildId: 'isolation-v1', input };
});
