import { createInvocationContext, type InvocationContext } from '@hile/context';
import {
  type MicroClient,
  type MicroContract,
  type MicroOperation,
} from '@hile/micro-contract';
import {
  assertMicroContract,
  getOperationMetadata,
  validateMicroValue,
} from '@hile/micro-contract/internal';
import { AbortException, Exception } from '@hile/message-modem';
import type { MicroHandler } from './message.js';
import { MICRO_EXECUTION_FAILED, MicroUnavailableError } from './contract-errors';

export type MicroBinding<C extends MicroContract> = Readonly<{
  local: MicroClient<C, InvocationContext>;
  activate(): void;
  close(): Promise<void>;
}>;

type ActiveExecution = {
  controller: AbortController;
  done: Promise<void>;
  release(): void;
  invocation: InvocationContext;
};

type BoundOperation = {
  operation: MicroOperation;
  handler: MicroHandler<MicroOperation>;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object'
    && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
}

function assertLocalInvocation(invocation: InvocationContext): InvocationContext {
  if (!invocation || typeof invocation !== 'object') throw new TypeError('A local call requires an invocation');
  const prototype = Object.getPrototypeOf(invocation);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('A local invocation must be a plain object');
  if (!Object.hasOwn(invocation, 'context') || !Object.hasOwn(invocation, 'signal')) {
    throw new TypeError('A local invocation requires own context and signal fields');
  }
  for (const key of Reflect.ownKeys(invocation)) {
    if (key !== 'context' && key !== 'signal') throw new TypeError('Unsupported local invocation option');
    if (!('value' in Object.getOwnPropertyDescriptor(invocation, key)!)) {
      throw new TypeError('Local invocation options must not be accessors');
    }
  }
  return createInvocationContext(invocation.context, invocation.signal, 'local Micro invocation');
}

/** One Application owns this derived registration and execution state. */
export class MicroContractRuntime<C extends MicroContract = MicroContract> {
  private state: 'loading' | 'inactive' | 'active' | 'draining' | 'closing' | 'closed' = 'loading';
  private readonly operations = new Map<string, BoundOperation>();
  private readonly network = new Set<ActiveExecution>();
  private readonly local = new Set<ActiveExecution>();
  private unload?: () => void;
  private closePromise?: Promise<void>;

  constructor(readonly contract: C, private readonly shutdownTimeoutMs: number) {
    assertMicroContract(contract);
  }

  bind(operation: MicroOperation, handler: MicroHandler<MicroOperation>, actualPath: string) {
    if (this.state !== 'loading') throw new TypeError('Micro contracts cannot be changed after loading');
    const metadata = getOperationMetadata(operation);
    if (metadata.contract !== this.contract) throw new TypeError('Message operation belongs to another Micro contract');
    if (actualPath !== operation.path) {
      throw new TypeError(`Micro operation ${metadata.key}: file route ${actualPath} does not match ${operation.path}`);
    }
    if (this.operations.has(metadata.key)) throw new TypeError(`Duplicate Micro operation: ${metadata.key}`);
    const bound = { operation, handler };
    this.operations.set(metadata.key, bound);
    return {
      execute: (data: unknown, invocation: InvocationContext) => this.execute(bound, data, invocation),
      release: () => {
        if (this.operations.get(metadata.key) === bound) this.operations.delete(metadata.key);
      },
    };
  }

  finish(unload: () => void): MicroBinding<C> {
    if (this.state !== 'loading') throw new TypeError('Micro contract loading has already ended');
    const local: Record<string, (data: unknown, invocation: InvocationContext) => Promise<unknown>> = {};
    for (const key of Object.keys(this.contract.operations)) {
      const bound = this.operations.get(key);
      if (!bound) throw new TypeError(`Missing Micro operation implementation: ${key}`);
      local[key] = async (data, invocation) => {
        if (this.state !== 'active' && this.state !== 'draining') throw new MicroUnavailableError();
        const execution = this.begin(this.local, assertLocalInvocation(invocation));
        try {
          return await this.execute(bound, data, execution.invocation);
        } finally {
          execution.release();
        }
      };
    }
    this.unload = unload;
    this.state = 'inactive';
    return Object.freeze({
      local: Object.freeze(local) as MicroClient<C, InvocationContext>,
      activate: () => {
        if (this.state === 'active') return;
        if (this.state !== 'inactive') throw new MicroUnavailableError();
        this.state = 'active';
      },
      close: () => this.close(),
    });
  }

  private begin(set: Set<ActiveExecution>, parent: InvocationContext): ActiveExecution {
    const controller = new AbortController();
    const abort = () => controller.abort(parent.signal.reason);
    if (parent.signal.aborted) abort();
    else parent.signal.addEventListener('abort', abort, { once: true });
    let finish!: () => void;
    let released = false;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const execution: ActiveExecution = {
      controller,
      done,
      invocation: createInvocationContext(parent.context, controller.signal, 'Micro execution'),
      release: () => {
        if (released) return;
        released = true;
        parent.signal.removeEventListener('abort', abort);
        set.delete(execution);
        finish();
      },
    };
    set.add(execution);
    return execution;
  }

  async networkInvocation(
    invocation: InvocationContext,
    dispatch: (invocation: InvocationContext) => Promise<unknown>,
  ): Promise<unknown> {
    if (this.state !== 'active') throw new MicroUnavailableError();
    const parsed = createInvocationContext(invocation?.context, invocation?.signal, 'inbound Micro invocation');
    const execution = this.begin(this.network, parsed);
    try {
      execution.invocation.signal.throwIfAborted();
      const result = await dispatch(execution.invocation);
      if (isAsyncIterable(result)) return this.trackIterable(result, execution);
      execution.release();
      return result;
    } catch (error) {
      execution.release();
      throw error;
    }
  }

  private trackIterable(iterable: AsyncIterable<unknown>, execution: ActiveExecution): AsyncIterable<unknown> {
    const iterator = iterable[Symbol.asyncIterator]();
    let ended = false;
    let cancellation: Promise<IteratorResult<unknown>> | undefined;
    const release = () => {
      if (ended) return;
      ended = true;
      execution.invocation.signal.removeEventListener('abort', abort);
      execution.release();
    };
    const cancel = (value?: unknown) => cancellation ??= (async () => {
      try {
        let result = await iterator.return?.(value) ?? { done: true, value };
        let immediateSteps = 0;
        while (!result.done && !ended) {
          // A generator may yield from finally while handling return(). Consume
          // those cleanup yields without starving the shutdown deadline.
          if (++immediateSteps % 32 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          result = await iterator.next();
        }
        if (result.done) release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    })();
    const abort = () => {
      // Allow cooperative finally blocks to finish; the shared shutdown deadline
      // still releases executions whose iterators never complete cancellation.
      void cancel().catch(() => undefined);
    };
    execution.invocation.signal.addEventListener('abort', abort, { once: true });
    if (execution.invocation.signal.aborted) abort();
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            try {
              execution.invocation.signal.throwIfAborted();
              const value = await iterator.next();
              execution.invocation.signal.throwIfAborted();
              if (value.done) release();
              return value;
            } catch (error) {
              if (!execution.invocation.signal.aborted) release();
              throw error;
            }
          },
          async return(value?: unknown) {
            try {
              const result = await (cancellation ?? iterator.return?.(value)) ?? { done: true, value };
              if (result.done) release();
              return result;
            } catch (error) {
              if (!execution.invocation.signal.aborted) release();
              throw error;
            }
          },
          async throw(error: unknown) {
            try {
              execution.invocation.signal.throwIfAborted();
              if (!iterator.throw) throw error;
              const result = await iterator.throw(error);
              if (result.done) release();
              return result;
            } catch (cause) {
              if (!execution.invocation.signal.aborted) release();
              throw cause;
            }
          },
        };
      },
    };
  }

  private async execute(bound: BoundOperation, data: unknown, invocation: InvocationContext): Promise<unknown> {
    if (this.state !== 'active' && this.state !== 'draining' && this.state !== 'closing') {
      throw new MicroUnavailableError();
    }
    const input = await validateMicroValue(bound.operation, 'input', data, 'provider_request', invocation.signal);
    invocation.signal.throwIfAborted();
    let output: unknown;
    try {
      output = await bound.handler({ data: input, invocation });
    } catch (cause) {
      if (invocation.signal.aborted) throw new AbortException();
      throw new ErrorWithSafeStatus(cause);
    }
    const response = await validateMicroValue(
      bound.operation,
      'output',
      output,
      'provider_response',
      invocation.signal,
    );
    invocation.signal.throwIfAborted();
    return response;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = this.state === 'active' ? 'draining' : 'closing';
    this.closePromise = this.drain();
    return this.closePromise;
  }

  private async drain(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      await Promise.all([...this.network].map((entry) => entry.done));
      if (this.state === 'closed') return;
      this.state = 'closing';
      await Promise.all([...this.local].map((entry) => entry.done));
    };
    try {
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const execution of [...this.network, ...this.local]) {
              execution.controller.abort(new AbortException('Micro application is shutting down'));
              execution.release();
            }
            resolve();
          }, this.shutdownTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.state = 'closed';
      try { this.unload?.(); }
      finally {
        this.unload = undefined;
        this.operations.clear();
      }
    }
  }
}

class ErrorWithSafeStatus extends Exception {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(MICRO_EXECUTION_FAILED, 'Micro operation failed');
    this.cause = cause;
  }
}
