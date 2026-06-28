import { QueueSchemaError } from './errors';
import type {
  InferQueueSchema,
  QueueDefinition,
  QueueSchema,
} from './types';

const VALID_QUEUE_NAME = /^[a-zA-Z0-9:_-]+$/;

export function defineQueue<
  const TName extends string,
  TSchema extends QueueSchema<any>,
>(name: TName, schema: TSchema): QueueDefinition<InferQueueSchema<TSchema>, TName>;
export function defineQueue<
  TData = unknown,
  const TName extends string = string,
>(name: TName): QueueDefinition<TData, TName>;
export function defineQueue<TData = unknown, const TName extends string = string>(
  name: TName,
  schema?: QueueSchema<TData>,
): QueueDefinition<TData, TName> {
  if (!VALID_QUEUE_NAME.test(name)) {
    throw new TypeError('Queue name must contain only letters, numbers, ":", "_" or "-"');
  }
  return schema ? { name, schema } : { name };
}

export function parsePayload<TData>(definition: QueueDefinition<TData>, payload: unknown): TData {
  const schema = definition.schema;
  if (!schema) return payload as TData;

  try {
    if ('parse' in schema && typeof schema.parse === 'function') {
      return schema.parse(payload);
    }

    if (!('safeParse' in schema) || typeof schema.safeParse !== 'function') {
      throw new TypeError('Queue schema must expose parse() or safeParse()');
    }

    const result = schema.safeParse(payload);
    if (result.success) return result.data;
    throw result.error;
  } catch (err) {
    throw new QueueSchemaError(definition.name, err);
  }
}
