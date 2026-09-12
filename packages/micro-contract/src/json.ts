type Visit = { value: unknown; target: object; key: string; leave?: never } | { leave: object };

function invalidJson(): never {
  throw new TypeError('Micro DTOs must contain only canonical JSON values');
}

function setValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Copies JSON data without invoking toJSON, getters, or custom prototype behavior. */
export function snapshotMicroJson<T>(value: T): T {
  const holder: { value?: unknown } = {};
  const active = new WeakSet<object>();
  const pending: Visit[] = [{ value, target: holder, key: 'value' }];
  while (pending.length > 0) {
    const task = pending.pop()!;
    if (task.leave) {
      active.delete(task.leave);
      continue;
    }
    const current = task.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      setValue(task.target, task.key, current);
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalidJson();
      setValue(task.target, task.key, Object.is(current, -0) ? 0 : current);
      continue;
    }
    if (typeof current !== 'object' || current === null || active.has(current)) invalidJson();
    const array = Array.isArray(current);
    const prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalidJson();
    const target = array ? new Array(current.length) : {};
    setValue(task.target, task.key, target);
    active.add(current);
    pending.push({ leave: current });
    const properties = Object.getOwnPropertyDescriptors(current);
    const keys = Reflect.ownKeys(properties);
    if (keys.some((key) => typeof key === 'symbol')) invalidJson();
    if (array) {
      if (keys.length !== current.length + 1) invalidJson();
      for (let index = current.length - 1; index >= 0; index--) {
        const property = properties[String(index)];
        if (!property || !('value' in property) || property.value === undefined) invalidJson();
        pending.push({ value: property.value, target, key: String(index) });
      }
    } else {
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index] as string;
        const property = properties[key];
        if (!property.enumerable) continue;
        if (!('value' in property)) invalidJson();
        if (property.value !== undefined) pending.push({ value: property.value, target, key });
      }
    }
  }
  return holder.value as T;
}
