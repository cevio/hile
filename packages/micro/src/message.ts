import type { InvocationContext } from '@hile/context';
import type { Readable } from 'node:stream';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { MicroOperation } from '@hile/micro-contract';
import { getOperationMetadata } from '@hile/micro-contract/internal';
import {
  defineMessage,
  type MessageFunction,
  type MessageRegisterProps,
  type MessageProtocolOptions,
} from '@hile/message-loader';
import type { Client, MicroMessageMetadata } from './client.js';

export type MicroMessageHandlerExtras = {
  client: Client;
  metadata?: MicroMessageMetadata;
  signal?: AbortSignal;
  input?: Readable;
  invocation: InvocationContext;
};

export type MicroMessageFunction<T = any> = MessageFunction<T, MicroMessageHandlerExtras>;

export type MicroHandler<O extends MicroOperation> = (
  message: Readonly<{
    data: StandardSchemaV1.InferOutput<O['input']>;
    invocation: InvocationContext;
  }>,
) => StandardSchemaV1.InferInput<O['output']> | Promise<StandardSchemaV1.InferInput<O['output']>>;

/** Metadata only; calling a definition directly never bypasses its executor. */
export const MICRO_CONTRACT_MESSAGE = Symbol.for('@hile/micro/contract-message');

export type MicroContractMessage<O extends MicroOperation = MicroOperation> =
  MessageRegisterProps<any, any> & Readonly<{
    [MICRO_CONTRACT_MESSAGE]: Readonly<{ operation: O; handler: MicroHandler<O> }>;
  }>;

export function getMicroContractMessage(definition: MessageRegisterProps) {
  return (definition as Partial<MicroContractMessage>)[MICRO_CONTRACT_MESSAGE];
}

/** Defines a file-loaded Micro business handler with an explicit invocation context. */
export function defineMicroMessage<T = any>(
  handler: MicroMessageFunction<T>,
  options?: MessageProtocolOptions,
): MessageRegisterProps<T, MicroMessageHandlerExtras>;
export function defineMicroMessage<const O extends MicroOperation>(
  operation: O,
  handler: MicroHandler<NoInfer<O>>,
): MicroContractMessage<O>;
export function defineMicroMessage(
  operationOrHandler: MicroOperation | MicroMessageFunction,
  handlerOrOptions?: MicroHandler<MicroOperation> | MessageProtocolOptions,
): MessageRegisterProps<any, any> {
  if (typeof operationOrHandler === 'function') {
    return defineMessage<any, MicroMessageHandlerExtras>(operationOrHandler, handlerOrOptions as MessageProtocolOptions | undefined);
  }
  getOperationMetadata(operationOrHandler);
  if (typeof handlerOrOptions !== 'function') throw new TypeError('A Micro operation requires one handler');
  const definition = defineMessage(() => {
    throw new TypeError('Typed Micro messages must be loaded with loadMicroContract()');
  });
  return Object.freeze({
    ...definition,
    [MICRO_CONTRACT_MESSAGE]: Object.freeze({
      operation: operationOrHandler,
      handler: handlerOrOptions,
    }),
  });
}
