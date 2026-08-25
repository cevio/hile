import { defineMicroMessage } from '@hile/micro';
export default defineMicroMessage(async ({ data, params, invocation }) => {
  return {
    type: 'pong',
    timestamp: Date.now(),
    data, params,
    requestId: invocation.context.values.requestId,
  }
});
