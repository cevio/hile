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
    const callback = await super.listen(port);
    await this.reconnectToRegistry();
    return async () => {
      if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
      await callback();
    }
  }

  private async reconnectToRegistry() {
    const registry = await this.connect(this._registry_address.host, this._registry_address.port);
    registry.events.on('disconnect', () => {
      this.registry = undefined;
      const reconnect = () => {
        this.reconnectToRegistry().catch(e => {
          this.reconnectTimeout = setTimeout(reconnect, 3000)
        });
      }
      reconnect();
    });
    this.registry = registry;
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