let notify;
export function bindProductResourceUpdates(listener) {
    if (notify)
        throw new Error('Product resource update notifier is already bound');
    notify = listener;
    return () => { if (notify === listener)
        notify = undefined; };
}
export function notifyProductResourceUpdated(id) {
    if (!notify)
        throw new Error('Product resource update notifier is unavailable');
    return notify(id);
}
