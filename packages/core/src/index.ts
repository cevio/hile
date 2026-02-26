export type ServiceCutDownFunction = () => unknown | Promise<unknown>;
export type ServiceCutDownHandler = (fn: ServiceCutDownFunction) => void;
export type ServiceFunction<R> = (fn: ServiceCutDownHandler) => R | Promise<R>;
export interface ServiceRegisterProps<R> {
  id: number
  fn: ServiceFunction<R>
}

interface Paddings<R = any> {
  status: -1 | 0 | 1;
  value: R;
  error?: any;
  queue: Set<{ resolve: (value: R) => void, reject: (error: any) => void }>;
}

export class Container {
  private id = 1;
  private readonly packages = new Map<Function, number>();
  private readonly paddings = new Map<number, Paddings>();

  private readonly shutdownFunctions = new Map<number, ServiceCutDownFunction[]>();
  private readonly shutdownQueues: number[] = [];

  private getId() {
    let i = this.id++;
    if (i >= Number.MAX_SAFE_INTEGER) {
      i = this.id = 1;
    }
    return i;
  }

  /**
   * 注册服务到容器
   * @param fn - 服务函数
   * @returns - 服务注册信息
   */
  public register<R>(fn: ServiceFunction<R>): ServiceRegisterProps<R> {
    if (this.packages.has(fn)) {
      return { id: this.packages.get(fn)!, fn }
    }
    const id = this.getId();
    this.packages.set(fn, id);
    return { id, fn }
  }

  /**
   * 从容器中解决服务
   * 当服务未注册时，会自动注册并运行服务
   * 当服务已注册时，会返回服务实例
   * 当服务运行中时，会等待服务运行完成并返回服务实例
   * 当服务运行完成时，会返回服务实例
   * 当服务运行失败时，会返回错误
   * 多次调用正在运行中的服务时，不会重复运行同一服务，而是将等待状态（Promise）加入到等待队列，
   * 直到服务运行完毕被 resolve 或者 reject
   * @param props - 服务注册信息
   * @returns - 服务实例
   */
  public resolve<R>(props: ServiceRegisterProps<R>): Promise<R> {
    const { id, fn } = props;
    return new Promise<R>((resolve, reject) => {
      if (!this.paddings.has(id)) {
        return this.run(id, fn, (e, v) => {
          if (e) {
            reject(e);
          } else {
            resolve(v!);
          }
        })
      }
      const state = this.paddings.get(id)!;
      switch (state.status) {
        case 0:
          state.queue.add({ resolve, reject });
          break;
        case 1:
          resolve(state.value);
          break;
        case -1:
          reject(state.error);
          break;
      }
    })
  }

  /**
   * 运行服务
   * 注意：运行服务过程中将自动按顺序注册销毁函数，
   * 如果服务启动失败，则立即执行销毁函数，并返回错误
   * 销毁函数执行都是逆向执行的
   * 先加入的后执行，后加入的先执行
   * @param id - 服务ID
   * @param fn - 服务函数
   * @param callback - 回调函数
   */
  private run<R>(id: number, fn: ServiceFunction<R>, callback: (e: any, v?: R) => void) {
    const state: Paddings = { status: 0, value: undefined, queue: new Set() }
    this.paddings.set(id, state);
    const curDown: ServiceCutDownHandler = (fn: ServiceCutDownFunction) => {
      if (!this.shutdownQueues.includes(id)) {
        this.shutdownQueues.push(id);
      }
      if (!this.shutdownFunctions.has(id)) {
        this.shutdownFunctions.set(id, []);
      }
      const pools = this.shutdownFunctions.get(id)!;
      if (!pools.includes(fn)) {
        pools.push(fn);
      }
    }
    Promise.resolve(fn(curDown)).then((value) => {
      state.status = 1;
      state.value = value;
      for (const queue of state.queue) {
        queue.resolve(value);
      }
      state.queue.clear();
      callback(null, value);
    }).catch(e => {
      state.status = -1;
      state.error = e;

      // 通知所有等待的任务结果是失败的，并清空等待队列
      const clear = () => {
        for (const queue of state.queue) {
          queue.reject(e);
        }
        state.queue.clear();
        callback(e);
      }

      // 已运行的销毁函数立即执行，
      // 无论成功失败都通知所有等待的任务结果是失败的，并清空等待队列
      this.shutdownService(id)
        .then(clear)
        .catch(clear);
    })
  }

  /**
   * 销毁服务
   * @param id - 服务ID
   * @returns - 销毁结果
   */
  private async shutdownService(id: number) {
    if (this.shutdownQueues.includes(id)) {
      const pools = this.shutdownFunctions.get(id)!;
      let i = pools.length;
      while (i--) {
        await Promise.resolve(pools[i]());
      }
      this.shutdownFunctions.clear();
      this.shutdownQueues.splice(this.shutdownQueues.indexOf(id), 1);
    }
  }

  /**
   * 销毁所有服务
   * 销毁过程都是逆向销毁的，
   * 先注册的后销毁，后注册的先销毁
   * @returns - 销毁结果
   */
  private async shutdown() {
    let i = this.shutdownQueues.length;
    while (i--) {
      await this.shutdownService(this.shutdownQueues[i]);
    }
    this.shutdownFunctions.clear();
    this.shutdownQueues.length = 0;
  }

  /**
   * 检查服务是否已注册
   * @param fn - 服务函数
   * @returns - 是否已注册
   */
  public hasService<R>(fn: ServiceFunction<R>) {
    return this.packages.has(fn);
  }

  /**
   * 检查服务是否已运行
   * @param id - 服务ID
   * @returns - 是否已运行
   */
  public hasMeta(id: number) {
    return this.paddings.has(id);
  }

  /**
   * 获取服务ID
   * @param fn - 服务函数
   * @returns - 服务ID
   */
  public getIdByService<R>(fn: ServiceFunction<R>) {
    return this.packages.get(fn);
  }

  /**
   * 获取服务元数据
   * @param id - 服务ID
   * @returns - 服务元数据
   */
  public getMetaById(id: number) {
    return this.paddings.get(id);
  }
}

export const container = new Container();
export function defineService<R>(fn: ServiceFunction<R>) {
  return container.register(fn);
}

export function loadService<R>(props: ServiceRegisterProps<R>): Promise<R> {
  return container.resolve(props);
}

export default container;