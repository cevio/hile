import type { InvocationContext } from '@hile/context';
import type { Readable } from 'node:stream';
import {
  defineMessage,
  type MessageFunction,
  type MessageRegisterProps,
} from '@hile/message-loader';
import type { Client, MicroMessageMetadata } from './client';

export type MicroMessageHandlerExtras = {
  client: Client;
  metadata?: MicroMessageMetadata;
  signal?: AbortSignal;
  input?: Readable;
  invocation: InvocationContext;
};

export type MicroMessageFunction<T = any> = MessageFunction<T, MicroMessageHandlerExtras>;

/** Defines a file-loaded Micro business handler with an explicit invocation context. */
export function defineMicroMessage<T = any>(
  handler: MicroMessageFunction<T>,
): MessageRegisterProps<T, MicroMessageHandlerExtras> {
  return defineMessage<T, MicroMessageHandlerExtras>(handler);
}
