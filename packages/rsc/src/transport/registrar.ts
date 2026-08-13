import type { RscPluginService } from '../plugin/service';
import { DEFAULT_RSC_OPERATIONS, type RscOperationMap } from './contracts';

export interface RscOperationInput {
  data: unknown;
  signal?: AbortSignal;
}

export interface RscOperationRegistrar {
  register(
    operation: string,
    handler: (input: RscOperationInput) => unknown,
  ): () => void;
}

const attachments = new WeakMap<RscPluginService, () => void>();

export function registerRscOperations(
  registrar: RscOperationRegistrar,
  registrations: ReadonlyArray<readonly [string, (input: RscOperationInput) => unknown]>,
): () => void {
  const unregister: Array<() => void> = [];
  const removeAll = () => {
    const errors: unknown[] = [];
    for (const remove of unregister.splice(0).reverse()) {
      try {
        remove();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to unregister RSC operations');
  };
  try {
    for (const [operation, handler] of registrations) {
      unregister.push(registrar.register(operation, handler));
    }
  } catch (error) {
    try {
      removeAll();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'RSC operation registration and rollback failed');
    }
    throw error;
  }
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    removeAll();
  };
}

export function attachRscPluginService(
  service: RscPluginService,
  registrar: RscOperationRegistrar,
  operations: RscOperationMap = DEFAULT_RSC_OPERATIONS,
): () => void {
  if (attachments.has(service)) throw new Error('RSC plugin service is already attached');
  const unregister = registerRscOperations(registrar, [
    [operations.describe, () => service.describe()],
    [operations.render, ({ data, signal }) => service.render(data, signal)],
    [operations.action, ({ data, signal }) => service.action(data, signal)],
  ]);
  let detached = false;
  let unsubscribe: () => void = () => undefined;

  function detach() {
    if (detached) return;
    detached = true;
    unsubscribe();
    try {
      unregister();
    } finally {
      attachments.delete(service);
    }
  }

  unsubscribe = service.onDeactivate(detach);
  if (detached) throw new Error('RSC plugin service is inactive');
  attachments.set(service, detach);
  return detach;
}
