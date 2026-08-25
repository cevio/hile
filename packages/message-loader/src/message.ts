let _id = 1;

export interface MessageRegisterProps<
  T = any,
  E extends Record<string, any> = {},
> {
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
>(fn: MessageFunction<T, E>): MessageRegisterProps<T, E> {
  const id = _id++;
  return {
    id,
    fn,
  }
}

export function getId() {
  return _id++;
}
