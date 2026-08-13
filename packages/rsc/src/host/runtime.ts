import type { RscRenderRequest } from '../plugin/types';
import type { RscFlightDecoder, RscPluginLocator } from '../transport';

export interface RscHostRuntimeOptions {
  locator: RscPluginLocator;
  decoder: RscFlightDecoder;
  verifyManifest?: boolean;
}

export interface RscHostRenderRequest {
  pluginId: string;
  request: RscRenderRequest;
  signal?: AbortSignal;
}

export class RscHostRuntime {
  private readonly locator: RscPluginLocator;
  private readonly decoder: RscFlightDecoder;
  private readonly verifyManifest: boolean;

  constructor(options: RscHostRuntimeOptions) {
    this.locator = options.locator;
    this.decoder = options.decoder;
    this.verifyManifest = options.verifyManifest ?? true;
  }

  public async render({ pluginId, request, signal }: RscHostRenderRequest) {
    const lease = await this.locator.resolve({ pluginId, buildId: request.buildId }, { signal });
    let releasePromise: Promise<void> | undefined;
    const release = () => releasePromise ??= Promise.resolve(lease.release());
    try {
      if (this.verifyManifest) {
        const manifest = await lease.client.describe({ signal });
        if (manifest.pluginId !== pluginId) {
          throw new Error(
            `RSC plugin identity mismatch: requested=${pluginId}, resolved=${manifest.pluginId}`,
          );
        }
        if (manifest.buildId !== request.buildId) {
          throw new Error(
            `RSC plugin build mismatch: requested=${request.buildId}, resolved=${manifest.buildId}`,
          );
        }
      }
      const flight = await lease.client.render(request, { signal });
      const leasedFlight: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          const iterator = flight[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const result = await iterator.next();
                if (result.done) await release();
                return result;
              } catch (error) {
                await release();
                throw error;
              }
            },
            async return(value?: unknown) {
              try {
                return iterator.return
                  ? await iterator.return(value)
                  : { done: true, value } as IteratorResult<Uint8Array>;
              } finally {
                await release();
              }
            },
            async throw(error?: unknown) {
              try {
                if (iterator.throw) return await iterator.throw(error);
                throw error;
              } finally {
                await release();
              }
            },
          };
        },
      };
      return await this.decoder.decode(leasedFlight, {
        pluginId,
        buildId: request.buildId,
        signal,
      });
    } catch (error) {
      await release();
      throw error;
    }
  }
}
