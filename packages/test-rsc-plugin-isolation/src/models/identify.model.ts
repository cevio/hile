import { defineActionModel } from '@hile/model';

export default defineActionModel(async (input: Record<string, unknown>, invocation) => {
  if (invocation.signal.aborted) throw invocation.signal.reason;
  return { pluginId: 'demo.rsc.isolation', buildId: 'isolation-v1', input };
});
