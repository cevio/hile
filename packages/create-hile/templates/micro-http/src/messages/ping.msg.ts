import { defineMessage } from '@hile/message-loader';
export default defineMessage(async ({ data, params }) => {
  return {
    type: 'pong',
    timestamp: Date.now(),
    data, params,
  }
});