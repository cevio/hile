let _id = 1;

export interface MessageRegisterProps {
  id: number;
  fn: MessageFunction;
}

export type MessageFunction = (data: {
  params?: Record<string, string>;
  data: any,
  url: string,
}) => any;

export function defineMessage(fn: MessageFunction): MessageRegisterProps {
  const id = _id++;
  return {
    id,
    fn,
  }
}