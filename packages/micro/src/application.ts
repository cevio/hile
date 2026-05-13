import { Client } from './client';
import { Server } from './server';
import { MessageLoaderProps } from '@hile/message-loader';
import { RegistryAddress } from './registry';

enum RegistryLookupStatus {
  IDLE,
  PENDING,
  READY,
}

export type ApplicationProps = {
  namespace: string;
  registry: RegistryAddress;
} & MessageLoaderProps;

export class Application extends Server {
  private registry?: Client;
  private reconnectTimeout?: NodeJS.Timeout;
  private registryReconnectPromise: Promise<void> | undefined;
  /** 为 true 时不再向 Registry 重连（listen 返回的 teardown 已触发） */
  private stopped = false;
  private readonly _registry_address: RegistryAddress;

  private readonly namespaces = new Map<string, {
    host: string;
    port: number;
    status: RegistryLookupStatus;
    handlers: Set<[(value: Client) => void, (reason?: any) => void]>
  }>();

  constructor(props: ApplicationProps) {
    const { namespace, registry, ...loaderProps } = props;
    super(namespace, loaderProps);
    this._registry_address = registry;
  }

  public async listen(port: number = 0) {
    this.stopped = false;
    const callback = await super.listen(port);
    await this.reconnectToRegistry();
    return async () => {
      this.stopped = true;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
      this.registry = undefined;
      await callback();
    };
  }

  private scheduleRegistryRetry() {
    if (this.stopped) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      void this.reconnectToRegistry().catch(() => {
        if (this.stopped) return;
        this.scheduleRegistryRetry();
      });
    }, 3000);
  }

  private async reconnectToRegistry(): Promise<void> {
    if (this.stopped) return;
    if (this.registryReconnectPromise) return this.registryReconnectPromise;

    this.registryReconnectPromise = (async () => {
      const registry = await this.connect(this._registry_address.host, this._registry_address.port);
      if (this.stopped) {
        registry.dispose();
        return;
      }
      registry.events.once('disconnect', () => {
        if (this.registry !== registry) return;
        this.registry = undefined;
        if (this.stopped) return;
        void this.reconnectToRegistry().catch(() => {
          if (this.stopped) return;
          this.scheduleRegistryRetry();
        });
      });
      this.registry = registry;
    })().finally(() => {
      this.registryReconnectPromise = undefined;
    });

    return this.registryReconnectPromise;
  }

  private async findFromRegistry(namespace: string) {
    if (!this.registry) throw new Error('Registry not found');
    const { response } = this.registry!.request('/-/find', { namespace });
    return await response<{ host: string, port: number } | undefined>();
  }

  public get(namespace: string) {
    if (!this.namespaces.has(namespace)) {
      this.namespaces.set(namespace, {
        host: '',
        port: 0,
        status: RegistryLookupStatus.IDLE,
        handlers: new Set(),
      });
    }
    const stack = this.namespaces.get(namespace)!;
    if (
      stack.status === RegistryLookupStatus.READY &&
      !this.clients.has(`${stack.host}:${stack.port}`)
    ) {
      stack.status = RegistryLookupStatus.IDLE;
      stack.host = '';
      stack.port = 0;
    }
    const key = `${stack.host}:${stack.port}`;
    if (stack.status === RegistryLookupStatus.READY && this.clients.has(key)) {
      return Promise.resolve(this.clients.get(key)!);
    }

    return new Promise<Client>((resolve, reject) => {
      stack.handlers.add([resolve, reject]);
      if (stack.status === RegistryLookupStatus.IDLE) {
        stack.status = RegistryLookupStatus.PENDING;
        this.findFromRegistry(namespace).then(data => {
          if (!data) return Promise.reject(new Error('Namespace not found'));
          return this.connect(data.host, data.port).then(client => {
            stack.host = data.host;
            stack.port = data.port;
            stack.status = RegistryLookupStatus.READY;
            for (const [resolve] of stack.handlers.values()) {
              resolve(client);
            }
            return client;
          })
        }).then(client => {
          client.events.on('disconnect', () => {
            if (this.namespaces.has(namespace)) {
              this.namespaces.delete(namespace);
            }
          });
        }).catch(e => {
          this.namespaces.delete(namespace);
          for (const [_, reject] of stack.handlers.values()) {
            reject(e);
          }
        }).finally(() => stack.handlers.clear())
      }
    })
  }
}
