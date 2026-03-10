let _id = 1;

export interface MessageRegisterProps<T = any> {
  id: number;
  fn: MessageFunction<T>;
}

export type MessageFunction<T = any> = (data: {
  params?: Record<string, string>;
  data: T,
  url: string,
}) => any;

export function defineMessage<T = any>(fn: MessageFunction<T>): MessageRegisterProps<T> {
  const id = _id++;
  return {
    id,
    fn,
  }
}