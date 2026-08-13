import { defineActionModel, getModelExecutionContext } from '@hile/model';

export default defineActionModel(async (input: Record<string, unknown>) => {
  const signal = getModelExecutionContext()?.signal;
  if (signal?.aborted) throw signal.reason;
  return { pluginId: 'demo.rsc.isolation', buildId: 'isolation-v1', input };
});
