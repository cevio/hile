import type { StandardSchemaV1 } from '@standard-schema/spec';
import { getOperationMetadata } from './contract.js';
import { MicroContractError } from './errors.js';
import { snapshotMicroJson } from './json.js';
import type { MicroContractPhase, MicroOperation } from './types.js';

export async function validateMicroValue<Operation extends MicroOperation, Direction extends 'input' | 'output'>(
  operation: Operation,
  direction: Direction,
  value: unknown,
  phase: MicroContractPhase,
  signal?: AbortSignal,
): Promise<StandardSchemaV1.InferOutput<Operation[Direction]>> {
  const metadata = getOperationMetadata(operation);
  if ((direction === 'input') !== (phase === 'client_request' || phase === 'provider_request')) {
    throw new TypeError('Micro validation phase does not match its schema direction');
  }
  signal?.throwIfAborted();
  let snapshot: unknown;
  try {
    snapshot = snapshotMicroJson(value);
  } catch (cause) {
    throw new MicroContractError(metadata, phase, 'wire', { cause });
  }
  let parsed: unknown;
  let hasIssues = false;
  try {
    const result = await operation[direction]['~standard'].validate(snapshot);
    if (typeof result !== 'object' || result === null) {
      throw new TypeError('Standard Schema returned an invalid validation result');
    }
    const issues = result.issues;
    hasIssues = issues !== undefined;
    if (hasIssues) {
      if (!Array.isArray(issues)) throw new TypeError('Standard Schema returned invalid issues');
    } else {
      if (!Object.hasOwn(result, 'value')) throw new TypeError('Standard Schema returned no value');
      parsed = (result as StandardSchemaV1.SuccessResult<unknown>).value;
    }
  } catch (cause) {
    signal?.throwIfAborted();
    throw new MicroContractError(metadata, phase, 'schema', { cause });
  }
  signal?.throwIfAborted();
  if (hasIssues) throw new MicroContractError(metadata, phase, 'validation');
  try {
    return snapshotMicroJson(parsed) as StandardSchemaV1.InferOutput<Operation[Direction]>;
  } catch (cause) {
    throw new MicroContractError(metadata, phase, 'wire', { cause });
  }
}
