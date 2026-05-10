import { MessageLoaderProps } from '@hile/message-loader';
import { Server } from './server';
import { Client } from './client';

export interface RegistryFindData {
  namespace: string;
}

export class Registry extends Server {
  private readonly namespaces = new Map<string, Set<string>>();

  constructor(props?: MessageLoaderProps) {
    super('registry', props);
    this.events.on('connect', (client:Client, extras: string[]) => {
      const key = client.host + ':' + client.port;
      const namespace = extras.join('/');
      if (!this.namespaces.has(namespace)) {
        this.namespaces.set(namespace, new Set());
      }
      this.namespaces.get(namespace)!.add(key);
    });
    this.events.on('disconnect', (client:Client, extras: string[]) => {
      const key = client.host + ':' + client.port;
      const namespace = extras.join('/');
      if (this.namespaces.has(namespace)) {
        const keys = this.namespaces.get(namespace)!;
        if (keys.has(key)) {
          keys.delete(key);
          if (keys.size === 0) {
            this.namespaces.delete(namespace);
          }
        }
      }
    });
    this.onFind();
  }

  public onFind() {
    this.register<RegistryFindData, { client: Client }>('/-/find', async ({ data }) => {
      const namespace = data.namespace;
      if (!this.namespaces.has(namespace)) return;
      const keys = this.namespaces.get(namespace)!;
      return Array.from(keys).map((key) => {
        return { host: key.split(':')[0], port: Number(key.split(':')[1]) };
      })[0]
    });
  }
}