import { Application, Client } from '@hile/micro';

export class DynamicConfigClient<T extends Record<string, any>> {
  private _value: T = {} as T;
  private _status: 0 | 1 | 2 = 0;
  private _subscribePromise: Promise<T> | undefined;
  private _client?: Client;
  private _closed = false;
  constructor(
    private readonly clients: MicroDynamicConfigClients,
    private readonly namespace: string,
    private readonly fields: (keyof T)[] = [],
  ) { }

  public setValue<K extends keyof T>(k: K, v: T[K]) {
    if (this.fields.includes(k)) {
      this._value[k] = v;
    }
    return this;
  }

  private async subscribe() {
    const client = await this.clients.app.get(this.namespace);
    const { response } = client.request('/-/dynamic-configs/subscribe', this.fields);
    const value = await response<T>();
    this._client = client;
    return value;
  }

  private async unsubscribe() {
    if (!this._client) return;
    const { response } = this._client!.request('/-/dynamic-configs/unsubscribe', this.fields);
    return await response<number>();
  }

  public getValue() {
    if (this._closed) return Promise.reject(new Error('Client is closed'));
    switch (this._status) {
      case 0:
        this._status = 1;
        return this._subscribePromise = new Promise<T>((resolve, reject) => {
          this.subscribe().then((value) => {
            if (this._closed) {
              this._client?.dispose();
              this._client = undefined;
              reject(new Error('Client is closed'));
              return;
            }
            this._value = value;
            const disconnect = () => {
              this._client?.events.off('disconnect', disconnect);
              this._status = 0;
            }
            this._client!.events.on('disconnect', disconnect);
            this._status = 2;
            resolve(this._value);
          }).catch(e => {
            this._status = 0;
            reject(e);
          }).finally(() => this._subscribePromise = undefined)
        })
      case 1: return this._subscribePromise;
      case 2: return Promise.resolve(this._value);
    }
  }

  public async close() {
    this._closed = true;
    await this.unsubscribe();
    this._status = 0;
    this._client = undefined;
  }
}

interface DynamicConfigClientOnChangeProps {
  key: string;
  newValue: any;
  oldValue: any;
  namespace: string;
}

export class MicroDynamicConfigClients {
  private readonly clients = new Map<string, DynamicConfigClient<any>>();
  constructor(public readonly app: Application) {
    this.app.register<DynamicConfigClientOnChangeProps>('/-/dynamic-configs/change', async ({ data }) => {
      if (this.clients.has(data.namespace)) {
        const client = this.clients.get(data.namespace)!;
        client.setValue(data.key, data.newValue);
      }
    })
  }

  public async subscribe<T extends Record<string, any>>(namespace: string, fields: (keyof T)[]) {
    if (!this.clients.has(namespace)) {
      this.clients.set(namespace, new DynamicConfigClient<T>(this, namespace, fields));
    }
    const client = this.clients.get(namespace)!;
    return await client.getValue();
  }

  public async close() {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }
}
