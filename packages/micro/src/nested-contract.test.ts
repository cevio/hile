import { describe, expect, it } from 'vitest';
import { createExecutionContext, createInvocationContext } from '@hile/context';
import { createMicroClient, defineMicroContract } from '@hile/micro-contract';
import { Exception } from '@hile/message-modem';
import { MicroContractRuntime } from './contract-runtime.js';
import { isNonRetryableMicroError, MICRO_EXECUTION_FAILED, toMicroTransportError } from './contract-errors.js';

describe('nested Micro contract execution', () => {
  it('does not replay an outer operation after an inner operation commits and fails output validation', async () => {
    const schema = { '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => typeof value === 'string'
        ? { value }
        : { issues: [{ message: 'Expected string' }] },
    } };
    const contract = defineMicroContract({
      namespace: 'test.nested',
      operations: {
        outer: { path: '/outer', input: schema, output: schema },
        inner: { path: '/inner', input: schema, output: schema },
      },
    });
    const runtime = new MicroContractRuntime(contract, 100);
    let outerCalls = 0;
    let innerCommits = 0;
    const outer = runtime.bind(contract.operations.outer, ({ data, invocation }) => {
      outerCalls++;
      return binding.local.inner(data as string, invocation);
    }, '/outer');
    runtime.bind(contract.operations.inner, () => {
      innerCommits++;
      return 123;
    }, '/inner');
    const binding = runtime.finish(() => {});
    binding.activate();
    const client = createMicroClient({
      async call(_namespace, _path, data, options) {
        let retries = options.retries ?? 0;
        for (;;) {
          try {
            return await runtime.networkInvocation(
              createInvocationContext(options.context, options.signal ?? new AbortController().signal),
              (invocation) => outer.execute(data, invocation),
            );
          } catch (error) {
            const failure = toMicroTransportError(error) as Exception;
            // Match the modem's fixed status/message boundary, never its local cause.
            const remoteError = new Exception(failure.status, failure.message);
            if (retries-- > 0 && !isNonRetryableMicroError(remoteError)) continue;
            throw remoteError;
          }
        }
      },
    }, contract);
    try {
      const error = await client.outer('value', {
        context: createExecutionContext({ requestId: 'nested-test' }),
        retries: 2,
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ status: MICRO_EXECUTION_FAILED, message: 'Micro operation failed' });
      expect(error).not.toHaveProperty('cause');
      expect(error).not.toHaveProperty('phase');
      expect(outerCalls).toBe(1);
      expect(innerCommits).toBe(1);
    } finally {
      await binding.close();
    }
  });
});
