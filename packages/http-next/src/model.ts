/**
 * 业务 model 定义句柄。仅应由 {@link defineModel} 构造，供 {@link loadModel} 调用 {@link ModelDefinition.create}。
 */
export type ModelDefinition<
  TArgs extends readonly unknown[] = readonly unknown[],
  T = unknown,
> = {
  readonly _hileModel: true;
  create(...args: TArgs): T | Promise<T>;
};

function isModelDefinition(
  value: unknown,
): value is ModelDefinition<readonly unknown[], unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "_hileModel" in value &&
    (value as ModelDefinition<readonly unknown[], unknown>)._hileModel === true &&
    typeof (value as ModelDefinition<readonly unknown[], unknown>).create ===
      "function"
  );
}

/**
 * 定义可被 {@link loadModel} 调用的 model（无 Hile 容器 key、不参与 `defineService` 生命周期）。
 *
 * **`create`** 可带任意参数；调用方在 **`loadModel(model, ...args)`** 中传入与 **`create`** 一致的参数，得到 **`create(...args)`** 的结果（同步或异步）。
 */
export function defineModel<
  TArgs extends readonly unknown[],
  T,
>(create: (...args: TArgs) => T | Promise<T>): ModelDefinition<TArgs, T> {
  return {
    _hileModel: true,
    create,
  };
}

/**
 * 使用给定参数执行 `model.create(...args)`，并以 Promise 返回其结果（与 `create` 是否 async 无关；**同步抛错**也会变为 **reject**）。
 */
export function loadModel<
  TArgs extends readonly unknown[],
  T,
>(model: ModelDefinition<TArgs, T>, ...args: TArgs): Promise<T> {
  if (!isModelDefinition(model)) {
    return Promise.reject(
      new TypeError("loadModel: 第一个参数必须是 defineModel 的返回值"),
    );
  }
  return Promise.resolve().then(() =>
    (model as ModelDefinition<TArgs, T>).create(...args),
  ) as Promise<T>;
}
