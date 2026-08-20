import type { RscPluginService } from '@hile/rsc/plugin';
import { attachRscPluginService } from '@hile/rsc/transport';
import {
  registerHileRscPluginDiscovery,
  type HileRscDiscoveryPublisherApplication,
  type HileRscPluginDiscoveryRegistration,
  type RegisterHileRscPluginDiscoveryOptions,
} from './publisher';

export interface HileRscPluginRuntimeApplication extends HileRscDiscoveryPublisherApplication {
  listen(port: number): Promise<() => Promise<void>>;
}

export interface HileRscPluginRuntimeOptions {
  application: HileRscPluginRuntimeApplication;
  service: RscPluginService;
  port: number;
  discovery: Omit<RegisterHileRscPluginDiscoveryOptions, 'application'>;
  /** Optional development adapter; production does not import development tooling. */
  bindDevelopment?: (
    publishArtifact: (artifactRoot: string) => Promise<unknown>,
  ) => Promise<() => void | Promise<void>>;
  /** Auxiliary watchers/resources started before this runtime and owned by it. */
  resources?: readonly { close(): void | Promise<void> }[];
}

async function settlePhase(operations: readonly (() => void | Promise<void>)[], message: string): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, message);
}

/** Composes transport, listener, explicit discovery security and optional development binding as one lifecycle. */
export class HileRscPluginRuntime {
  readonly #options: HileRscPluginRuntimeOptions;
  readonly #resources: Set<{ close(): void | Promise<void> }>;
  #detach?: () => void;
  #stop?: () => Promise<void>;
  #discovery?: HileRscPluginDiscoveryRegistration;
  #unbindDevelopment?: () => void | Promise<void>;
  #startPromise?: Promise<void>;
  #closePromise?: Promise<void>;
  #started = false;
  #closing = false;
  #deactivated = false;
  #drained = false;

  public constructor(options: HileRscPluginRuntimeOptions) {
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError('RSC plugin runtime port must be an integer between 0 and 65535');
    }
    this.#options = options;
    this.#resources = new Set(options.resources ?? []);
  }

  public start(): Promise<void> {
    if (this.#closing) return Promise.reject(new Error('Hile RSC plugin runtime is closing'));
    if (this.#started) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    const operation = (async () => {
      try {
        this.#detach = attachRscPluginService(this.#options.service, this.#options.application);
        this.#stop = await this.#options.application.listen(this.#options.port);
        this.#discovery = await registerHileRscPluginDiscovery({
          ...this.#options.discovery,
          application: this.#options.application,
        });
        if (this.#options.bindDevelopment) {
          this.#unbindDevelopment = await this.#options.bindDevelopment((artifactRoot) =>
            this.#discovery!.update(artifactRoot));
        }
        this.#started = true;
      } catch (error) {
        this.#closing = true;
        try { await this.#cleanup(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Hile RSC plugin runtime startup and rollback failed');
        }
        throw error;
      }
    })();
    const tracked = operation.finally(() => {
      if (this.#startPromise === tracked) this.#startPromise = undefined;
    });
    this.#startPromise = tracked;
    return tracked;
  }

  async #cleanup(): Promise<void> {
    await settlePhase([
      async () => {
        if (!this.#discovery) return;
        await this.#discovery.close();
        this.#discovery = undefined;
      },
      async () => {
        if (!this.#unbindDevelopment) return;
        await this.#unbindDevelopment();
        this.#unbindDevelopment = undefined;
      },
    ], 'Hile RSC plugin publication cleanup failed');
    await settlePhase([
      ...[...this.#resources].map((resource) => async () => {
        await resource.close();
        this.#resources.delete(resource);
      }),
    ], 'Hile RSC plugin auxiliary resource cleanup failed');
    await settlePhase([
      () => {
        if (this.#deactivated) return;
        this.#options.service.deactivate();
        this.#deactivated = true;
      },
    ], 'Hile RSC plugin deactivation failed');
    await settlePhase([
      async () => {
        if (this.#drained) return;
        await this.#options.service.drain();
        this.#drained = true;
      },
    ], 'Hile RSC plugin service cleanup failed');
    await settlePhase([
      () => {
        this.#detach?.();
        this.#detach = undefined;
      },
      async () => {
        if (!this.#stop) return;
        await this.#stop();
        this.#stop = undefined;
      },
    ], 'Hile RSC plugin runtime cleanup failed');
  }

  public close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const operation = (async () => {
      await this.#startPromise?.catch(() => undefined);
      await this.#cleanup();
      this.#started = false;
    })();
    const tracked = operation.catch((error) => {
      if (this.#closePromise === tracked) this.#closePromise = undefined;
      throw error;
    });
    this.#closePromise = tracked;
    return tracked;
  }
}
