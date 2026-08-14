let notify: ((id: string) => Promise<void>) | undefined;

export function bindProductResourceUpdates(listener: (id: string) => Promise<void>) {
  if (notify) throw new Error('Product resource update notifier is already bound');
  notify = listener;
  return () => { if (notify === listener) notify = undefined; };
}

export function notifyProductResourceUpdated(id: string) {
  if (!notify) throw new Error('Product resource update notifier is unavailable');
  return notify(id);
}
