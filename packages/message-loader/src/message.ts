import { validateProtocol } from './protocol';

let _id = 1;

export interface MessageProtocolOptions {
  /** Omit for ordinary messages. Protocol tags are routing metadata, not authorization. */
  protocol?: string;
}

export interface MessageRegisterProps<
  T = any,
  E extends Record<string, any> = {},
> extends MessageProtocolOptions {
  id: number;
  fn: MessageFunction<T, E>;
}

export type MessageFunction<T = any, E extends Record<string, any> = {}> = (data: {
  params?: Record<string, string>;
  data: T,
  url: string,
} & E) => any;

export function defineMessage<
  T = any,
  E extends Record<string, any> = {},
>(fn: MessageFunction<T, E>, options: MessageProtocolOptions = {}): MessageRegisterProps<T, E> {
  const protocol = options.protocol;
  validateProtocol(protocol);
  const id = _id++;
  return {
    id,
    fn,
    ...(protocol === undefined ? {} : { protocol }),
  }
}

export function getId() {
  return _id++;
}
