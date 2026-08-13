import { Loader, normalizePath, type ScannedFile } from '@hile/loader';
import {
  isActionModel,
  isModel,
  loadModel,
  type ActionModelDefinition,
} from './model';

export type ModelActionRegistryErrorCode =
  | 'ERR_MODEL_ACTION_INVALID_MODULE'
  | 'ERR_MODEL_ACTION_INVALID_ID'
  | 'ERR_MODEL_ACTION_DUPLICATE'
  | 'ERR_MODEL_ACTION_NOT_FOUND'
  | 'ERR_MODEL_ACTION_INVALID_INPUT';

export class ModelActionRegistryError extends Error {
  constructor(public readonly code: ModelActionRegistryErrorCode, message: string) {
    super(message);
    this.name = 'ModelActionRegistryError';
  }
}

export interface ModelActionLoadOptions { cacheBust?: string | number; }

function actionId(routePath: string): string {
  const value = routePath.replace(/^\/+|\/+$/g, '');
  if (!value || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ModelActionRegistryError(
      'ERR_MODEL_ACTION_INVALID_ID',
      `Invalid action model path: ${routePath}`,
    );
  }
  return value;
}

function assertInput(input: unknown): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ModelActionRegistryError(
      'ERR_MODEL_ACTION_INVALID_INPUT',
      'Action model input must be an object',
    );
  }
}

/** Atomic, reloadable registry populated from domain-organized `*.model.*` files. */
export class ModelActionRegistry extends Loader<unknown> {
  private readonly models = new Map<string, ActionModelDefinition>();

  constructor() {
    super({ suffix: 'model', defaultSuffix: '/index' });
  }

  protected bind(file: ScannedFile, model: unknown): (() => void) | void {
    if (!isModel(model)) {
      throw new ModelActionRegistryError(
        'ERR_MODEL_ACTION_INVALID_MODULE',
        `Model file must default-export defineModel() or defineActionModel(): ${file.relative}`,
      );
    }
    if (!isActionModel(model)) return;
    const id = actionId(normalizePath(file.routePath));
    if (this.models.has(id)) {
      throw new ModelActionRegistryError(
        'ERR_MODEL_ACTION_DUPLICATE',
        `Duplicate action model id: ${id}`,
      );
    }
    this.models.set(id, model);
    return () => {
      if (this.models.get(id) === model) this.models.delete(id);
    };
  }

  public ids(): string[] {
    return [...this.models.keys()].sort();
  }

  public has(id: string): boolean {
    return this.models.has(id);
  }

  public async invoke(id: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<unknown> {
    assertInput(input);
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const model = this.models.get(id);
    if (!model) {
      throw new ModelActionRegistryError(
        'ERR_MODEL_ACTION_NOT_FOUND',
        `Unknown action model: ${id}`,
      );
    }
    return loadModel(model, input, { signal: options.signal });
  }
}
