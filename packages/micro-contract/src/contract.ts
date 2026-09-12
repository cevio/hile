import type { MicroContract, MicroOperation, MicroOperationMetadata } from './types.js';

const contracts = new WeakSet<object>();
const operations = new WeakMap<object, MicroOperationMetadata>();
const reservedKeys = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'then',
  'toJSON',
  'prototype',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertFields(value: Record<string, unknown>, allowed: readonly string[], boundary: string): void {
  if (allowed.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`Missing required ${boundary} field`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new TypeError(`Unsupported ${boundary} field`);
    }
    if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) {
      throw new TypeError(`${boundary} fields must not be accessors`);
    }
  }
}

function assertSchema(value: unknown): void {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    throw new TypeError('A Micro operation requires Standard Schema input and output schemas');
  }
  const standard = (value as { '~standard'?: unknown })['~standard'];
  if (typeof standard !== 'object' || standard === null) {
    throw new TypeError('A Micro operation requires Standard Schema input and output schemas');
  }
  const candidate = standard as { version?: unknown; vendor?: unknown; validate?: unknown };
  if (candidate.version !== 1 || typeof candidate.vendor !== 'string' || !candidate.vendor ||
      typeof candidate.validate !== 'function') {
    throw new TypeError('A Micro operation requires Standard Schema version 1');
  }
}

function assertPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 2048 || !path.startsWith('/') ||
      (path !== '/' && path.endsWith('/')) || path.includes('//') ||
      /[\s\\\[\]{}:*?#()%]/u.test(path) ||
      path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError('Micro operation paths must be canonical fixed absolute paths');
  }
}

export function defineMicroContract<const Operations extends Record<string, MicroOperation>>(
  definition: MicroContract<Operations>,
): MicroContract<Operations> {
  if (!isPlainRecord(definition)) throw new TypeError('A Micro contract must be a plain object');
  assertFields(definition, ['namespace', 'operations'], 'Micro contract');
  if (typeof definition.namespace !== 'string' || definition.namespace.length > 256 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(definition.namespace)) {
    throw new TypeError('A Micro contract requires a bounded service namespace');
  }
  if (!isPlainRecord(definition.operations)) throw new TypeError('Micro operations must be a plain object');
  const entries = Reflect.ownKeys(definition.operations);
  if (entries.length === 0) throw new TypeError('A Micro contract requires at least one operation');
  const paths = new Set<string>();
  const copied: Record<string, MicroOperation> = {};
  for (const key of entries) {
    if (typeof key !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) || reservedKeys.has(key)) {
      throw new TypeError('Micro operation keys must be nonreserved JavaScript identifiers');
    }
    const property = Object.getOwnPropertyDescriptor(definition.operations, key)!;
    if (!('value' in property) || !isPlainRecord(property.value)) {
      throw new TypeError('Micro operation definitions must be plain data');
    }
    const operation = property.value;
    assertFields(operation, ['path', 'input', 'output'], 'Micro operation');
    assertPath(operation.path);
    if (paths.has(operation.path)) throw new TypeError('Duplicate Micro operation path');
    assertSchema(operation.input);
    assertSchema(operation.output);
    paths.add(operation.path);
    copied[key] = Object.freeze({ path: operation.path, input: operation.input, output: operation.output }) as MicroOperation;
  }
  const contract = Object.freeze({
    namespace: definition.namespace,
    operations: Object.freeze(copied),
  }) as MicroContract<Operations>;
  contracts.add(contract);
  for (const [key, operation] of Object.entries(copied)) {
    operations.set(operation, Object.freeze({ namespace: contract.namespace, key, path: operation.path, contract }));
  }
  return contract;
}

export function assertMicroContract(value: unknown): asserts value is MicroContract {
  if (typeof value !== 'object' || value === null || !contracts.has(value)) {
    throw new TypeError('Expected a contract returned by defineMicroContract');
  }
}

export function getOperationMetadata(operation: MicroOperation): MicroOperationMetadata {
  const metadata = operations.get(operation);
  if (!metadata) throw new TypeError('Expected an operation owned by defineMicroContract');
  return metadata;
}
