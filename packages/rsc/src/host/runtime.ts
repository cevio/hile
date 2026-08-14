import type { RscRenderRequest } from '../plugin/types';
import type { RscCallOptions, RscFlightDecoder, RscPluginLocator } from '../transport';

export interface RscHostRuntimeOptions {
  locator: RscPluginLocator;
  decoder: RscFlightDecoder;
  verifyManifest?: boolean;
  verificationCache?: Map<string, Promise<void>>;
  verificationCacheSize?: number;
  verificationTimeout?: number;
  observe?: RscHostRuntimeObserver;
}

export interface RscHostRuntimeEvent {
  operation: 'render';
  pluginId: string;
  buildId: string;
  outcome: 'success' | 'error' | 'cancelled';
  durationMs: number;
  bytes: number;
  error?: unknown;
}

export type RscHostRuntimeObserver = (event: RscHostRuntimeEvent) => void;

const MAX_STREAM_WINDOW = 64;
const MAX_TIMER_DELAY = 2_147_483_647;

function validateCallOptions(timeout?: number, idleTimeout?: number, window?: number): void {
  for (const [name, value] of [['timeout', timeout], ['idleTimeout', idleTimeout]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY)) {
      throw new TypeError(`RSC ${name} must be an integer between 1 and ${MAX_TIMER_DELAY}`);
    }
  }
  if (window !== undefined && (!Number.isSafeInteger(window) || window < 1 || window > MAX_STREAM_WINDOW)) {
    throw new TypeError(`RSC stream window must be an integer between 1 and ${MAX_STREAM_WINDOW}`);
  }
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === 'AbortError');
}

export interface RscHostRenderRequest extends RscCallOptions {
  pluginId: string;
  request: RscRenderRequest;
}

export class RscHostRuntime {
  private readonly locator: RscPluginLocator;
  private readonly decoder: RscFlightDecoder;
  private readonly verifyManifest: boolean;
  private readonly verificationCache: Map<string, Promise<void>>;
  private readonly verificationCacheSize: number;
  private readonly verificationTimeout: number;
  private readonly observe?: RscHostRuntimeObserver;

  constructor(options: RscHostRuntimeOptions) {
    this.locator = options.locator;
    this.decoder = options.decoder;
    this.verifyManifest = options.verifyManifest ?? true;
    this.verificationCache = options.verificationCache ?? new Map();
    this.verificationCacheSize = options.verificationCacheSize ?? 256;
    if (!Number.isSafeInteger(this.verificationCacheSize) || this.verificationCacheSize < 1) {
      throw new TypeError('RSC verification cache size must be a positive safe integer');
    }
    this.verificationTimeout = options.verificationTimeout ?? 30_000;
    validateCallOptions(this.verificationTimeout);
    this.observe = options.observe;
  }

  private async verify(
    pluginId: string,
    buildId: string,
    verificationKey: string | undefined,
  ): Promise<void> {
    const performVerification = async () => {
      const verificationLease = await this.locator.resolve(
        { pluginId, buildId },
        { timeout: this.verificationTimeout },
      );
      let manifest: { pluginId: string; buildId: string } | undefined;
      let primaryError: unknown;
      try {
        if (verificationLease.verificationKey !== verificationKey) {
          throw new Error('RSC plugin endpoint changed during manifest verification');
        }
        manifest = await verificationLease.client.describe({ timeout: this.verificationTimeout });
        if (manifest.pluginId !== pluginId) {
          throw new Error(
            `RSC plugin identity mismatch: requested=${pluginId}, resolved=${manifest.pluginId}`,
          );
        }
        if (manifest.buildId !== buildId) {
          throw new Error(
            `RSC plugin build mismatch: requested=${buildId}, resolved=${manifest.buildId}`,
          );
        }
      } catch (error) {
        primaryError = error;
      }
      let cleanupError: unknown;
      try {
        await verificationLease.release();
      } catch (error) {
        cleanupError = error;
      }
      if (primaryError !== undefined && cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'RSC manifest verification and lease cleanup failed',
        );
      }
      if (primaryError !== undefined) throw primaryError;
      if (cleanupError !== undefined) throw cleanupError;
    };
    if (verificationKey === undefined) {
      await performVerification();
      return;
    }
    const key = JSON.stringify([pluginId, buildId, verificationKey]);
    let verification = this.verificationCache.get(key);
    if (verification) {
      this.verificationCache.delete(key);
      this.verificationCache.set(key, verification);
    }
    if (!verification) {
      verification = performVerification().catch((error) => {
        if (this.verificationCache.get(key) === verification) {
          this.verificationCache.delete(key);
        }
        throw error;
      });
      this.verificationCache.set(key, verification);
      while (this.verificationCache.size > this.verificationCacheSize) {
        this.verificationCache.delete(this.verificationCache.keys().next().value!);
      }
    }
    await verification;
  }

  private async waitForVerification(
    verification: Promise<void>,
    signal: AbortSignal | undefined,
    timeout: number | undefined,
  ): Promise<void> {
    if (!signal && timeout === undefined) return verification;
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      if (signal) {
        onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (timeout !== undefined) {
        timer = setTimeout(() => reject(new Error('RSC manifest verification timed out')), timeout);
        timer.unref?.();
      }
    });
    try {
      await Promise.race([verification, interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  public async render({
    pluginId,
    request,
    signal,
    timeout,
    idleTimeout,
    window,
  }: RscHostRenderRequest) {
    const startedAt = performance.now();
    let bytes = 0;
    let observed = false;
    const finish = (outcome: RscHostRuntimeEvent['outcome'], error?: unknown) => {
      if (observed) return;
      observed = true;
      try {
        this.observe?.({
          operation: 'render',
          pluginId,
          buildId: request.buildId,
          outcome,
          durationMs: performance.now() - startedAt,
          bytes,
          ...(error === undefined ? {} : { error }),
        });
      } catch {
        // Observation must not alter request state.
      }
    };
    try {
      validateCallOptions(timeout, idleTimeout, window);
      signal?.throwIfAborted();
    } catch (error) {
      finish(isCancellation(error, signal) ? 'cancelled' : 'error', error);
      throw error;
    }
    let lease: Awaited<ReturnType<RscPluginLocator['resolve']>>;
    try {
      lease = await this.locator.resolve({ pluginId, buildId: request.buildId }, { signal });
    } catch (error) {
      finish(isCancellation(error, signal) ? 'cancelled' : 'error', error);
      throw error;
    }
    let releasePromise: Promise<void> | undefined;
    const release = () => releasePromise ??= Promise.resolve().then(() => lease.release());
    try {
      if (this.verifyManifest) {
        const verification = this.verify(
          pluginId,
          request.buildId,
          lease.verificationKey,
        );
        await this.waitForVerification(verification, signal, timeout);
      }
      const flight = await lease.client.render(request, {
        signal,
        timeout,
        idleTimeout,
        window,
      });
      let cancelled = false;
      let streamError: unknown;
      let streamDone = false;
      let decodeSettled = false;
      const settleObservation = () => {
        if (!decodeSettled || !streamDone) return;
        if (streamError !== undefined) {
          finish(isCancellation(streamError, signal) ? 'cancelled' : 'error', streamError);
        } else {
          finish(cancelled ? 'cancelled' : 'success');
        }
      };
      const finishStream = async (error?: unknown) => {
        if (error !== undefined) streamError = error;
        try {
          await release();
        } catch (cleanupError) {
          streamError = streamError === undefined || streamError === cleanupError
            ? cleanupError
            : new AggregateError(
              [streamError, cleanupError],
              'RSC Flight stream and lease cleanup failed',
            );
          streamDone = true;
          settleObservation();
          throw streamError;
        }
        streamDone = true;
        settleObservation();
      };
      const leasedFlight: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          const iterator = flight[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const result = await iterator.next();
                if (result.done) {
                  await finishStream();
                } else {
                  bytes += result.value.byteLength;
                }
                return result;
              } catch (error) {
                if (!streamDone) await finishStream(error);
                throw error;
              }
            },
            async return(value?: unknown) {
              let result: IteratorResult<Uint8Array>;
              try {
                result = iterator.return
                  ? await iterator.return(value)
                  : { done: true, value } as IteratorResult<Uint8Array>;
              } catch (error) {
                await finishStream(error);
                throw error;
              }
              if (result.done) {
                cancelled = true;
                await finishStream();
              } else {
                bytes += result.value.byteLength;
              }
              return result;
            },
            async throw(error?: unknown) {
              if (!iterator.throw) {
                await finishStream(error);
                throw error;
              }
              let result: IteratorResult<Uint8Array>;
              try {
                result = await iterator.throw(error);
              } catch (thrown) {
                await finishStream(thrown);
                throw thrown;
              }
              if (result.done) await finishStream();
              else bytes += result.value.byteLength;
              return result;
            },
          };
        },
      };
      const decoded = await this.decoder.decode(leasedFlight, {
        pluginId,
        buildId: request.buildId,
        signal,
      });
      decodeSettled = true;
      settleObservation();
      if (streamError !== undefined) throw streamError;
      return decoded;
    } catch (error) {
      let thrown = error;
      try {
        await release();
      } catch (cleanupError) {
        if (cleanupError !== error
          && !(error instanceof AggregateError && error.errors.includes(cleanupError))) {
          thrown = new AggregateError([error, cleanupError], 'RSC render and lease cleanup failed');
        }
      }
      finish(isCancellation(error, signal) ? 'cancelled' : 'error', thrown);
      throw thrown;
    }
  }
}
