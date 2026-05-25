import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Container, isService, defineService, loadService, formatServiceKey } from './index'

describe('Container', () => {
  let container: Container
  let keySeq = 0

  beforeEach(() => {
    container = new Container()
    keySeq = 0
  })

  const svcKey = () => `svc:${keySeq++}`

  describe('register - 注册服务到容器', () => {
    it('应注册服务并返回包含 fn、flag 与 key 的注册信息', () => {
      const fn = () => 'hello'
      const result = container.register(svcKey(), fn)
      expect(result).toHaveProperty('flag')
      expect(result).toHaveProperty('key')
      expect(result.fn).toBe(fn)
    })

    it('重复注册同一 key 应返回相同 key（可更新工厂函数）', () => {
      const dupKey = 'dup'
      const fn = () => 'hello'
      const first = container.register(dupKey, fn)
      const second = container.register(dupKey, () => 'other')
      expect(first.key).toBe(second.key)
      expect(first.fn).toBe(fn)
      expect(second.fn).not.toBe(fn)
    })

    it('不同 key 应得到不同的注册项', () => {
      const fn1 = () => 'a'
      const fn2 = () => 'b'
      const r1 = container.register(svcKey(), fn1)
      const r2 = container.register(svcKey(), fn2)
      expect(r1.key).not.toBe(r2.key)
    })
  })

  describe('resolve - 从容器中解决服务', () => {
    it('当服务未注册时，会自动注册并运行服务', async () => {
      const fn = () => 42
      const props = container.register(svcKey(), fn)
      const result = await container.resolve(props)
      expect(result).toBe(42)
    })

    it('当服务运行完成时，会返回服务实例（缓存）', async () => {
      let callCount = 0
      const fn = () => ++callCount
      const props = container.register(svcKey(), fn)

      const first = await container.resolve(props)
      const second = await container.resolve(props)

      expect(first).toBe(1)
      expect(second).toBe(1)
      expect(callCount).toBe(1)
    })

    it('当服务返回 Promise 时，应正确解析异步结果', async () => {
      const fn = () => Promise.resolve('async-value')
      const props = container.register(svcKey(), fn)
      const result = await container.resolve(props)
      expect(result).toBe('async-value')
    })

    it('当服务运行失败时，会返回错误', async () => {
      const fn = () => { throw new Error('service failed') }
      const props = container.register(svcKey(), fn)
      await expect(container.resolve(props)).rejects.toThrow('service failed')
    })

    it('当异步服务运行失败时，会返回错误', async () => {
      const fn = () => Promise.reject(new Error('async failed'))
      const props = container.register(svcKey(), fn)
      await expect(container.resolve(props)).rejects.toThrow('async failed')
    })

    it('当服务运行中时，会等待服务运行完成并返回服务实例', async () => {
      let resolveFn!: (value: string) => void
      const fn = () => new Promise<string>(r => { resolveFn = r })
      const props = container.register(svcKey(), fn)

      const p1 = container.resolve(props)
      const p2 = container.resolve(props)

      resolveFn('done')

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toBe('done')
      expect(r2).toBe('done')
    })

    it('多次调用正在运行中的服务时，不会重复运行同一服务', async () => {
      let callCount = 0
      let resolveFn!: (value: number) => void
      const fn = () => {
        callCount++
        return new Promise<number>(r => { resolveFn = r })
      }
      const props = container.register(svcKey(), fn)

      const p1 = container.resolve(props)
      const p2 = container.resolve(props)
      const p3 = container.resolve(props)

      resolveFn(99)

      const [r1, r2, r3] = await Promise.all([p1, p2, p3])
      expect(r1).toBe(99)
      expect(r2).toBe(99)
      expect(r3).toBe(99)
      expect(callCount).toBe(1)
    })

    it('多次调用运行中的服务失败时，所有等待者都收到 reject', async () => {
      let rejectFn!: (error: any) => void
      const fn = () => new Promise<string>((_, reject) => { rejectFn = reject })
      const props = container.register(svcKey(), fn)

      const p1 = container.resolve(props)
      const p2 = container.resolve(props)
      const p3 = container.resolve(props)

      rejectFn(new Error('boom'))

      await expect(p1).rejects.toThrow('boom')
      await expect(p2).rejects.toThrow('boom')
      await expect(p3).rejects.toThrow('boom')
    })

    it('已失败的服务再次 resolve 时直接返回错误', async () => {
      const fn = () => Promise.reject(new Error('fail'))
      const props = container.register(svcKey(), fn)

      await expect(container.resolve(props)).rejects.toThrow('fail')
      await expect(container.resolve(props)).rejects.toThrow('fail')
    })

    it('服务函数会收到 shutdown 注册器参数', async () => {
      const fn = vi.fn((_shutdown) => 'ok')
      const props = container.register(svcKey(), fn)
      await container.resolve(props)
      expect(fn).toHaveBeenCalledWith(expect.any(Function))
    })
  })

  describe('shutdown - 销毁功能', () => {
    it('服务启动失败时，立即执行已注册的销毁函数', async () => {
      const teardown = vi.fn()
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(teardown)
        await Promise.resolve()
        throw new Error('boot failed')
      }
      const props = container.register(svcKey(), fn)

      await expect(container.resolve(props)).rejects.toThrow('boot failed')
      expect(teardown).toHaveBeenCalledOnce()
    })

    it('异步服务启动失败时，立即执行已注册的销毁函数', async () => {
      const teardown = vi.fn()
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(teardown)
        throw new Error('async boot failed')
      }
      const props = container.register(svcKey(), fn)

      await expect(container.resolve(props)).rejects.toThrow('async boot failed')
      expect(teardown).toHaveBeenCalledOnce()
    })

    it('销毁函数按逆序执行（先加入的后执行，后加入的先执行）', async () => {
      const order: number[] = []
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => order.push(1))
        shutdown(() => order.push(2))
        shutdown(() => order.push(3))
        throw new Error('fail')
      }
      const props = container.register(svcKey(), fn)

      await expect(container.resolve(props)).rejects.toThrow('fail')
      expect(order).toEqual([3, 2, 1])
    })

    it('销毁函数支持异步', async () => {
      const order: number[] = []
      const fn = async (shutdown: (fn: () => Promise<void>) => void) => {
        shutdown(async () => { order.push(1) })
        shutdown(async () => { order.push(2) })
        throw new Error('fail')
      }
      const props = container.register(svcKey(), fn)

      await expect(container.resolve(props)).rejects.toThrow('fail')
      expect(order).toEqual([2, 1])
    })

    it('服务成功时不会执行销毁函数', async () => {
      const teardown = vi.fn()
      const fn = (shutdown: (fn: () => void) => void) => {
        shutdown(teardown)
        return 'ok'
      }
      const props = container.register(svcKey(), fn)

      const result = await container.resolve(props)
      expect(result).toBe('ok')
      expect(teardown).not.toHaveBeenCalled()
    })

    it('重复注册同一个销毁函数只会执行一次', async () => {
      const teardown = vi.fn()
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(teardown)
        shutdown(teardown)
        shutdown(teardown)
        throw new Error('fail')
      }
      const props = container.register(svcKey(), fn)

      await expect(container.resolve(props)).rejects.toThrow('fail')
      expect(teardown).toHaveBeenCalledOnce()
    })

    it('服务失败时，销毁函数执行完毕后才通知等待队列', async () => {
      const events: string[] = []
      let rejectFn!: (e: Error) => void

      const fn = (shutdown: (fn: () => void) => void) => {
        shutdown(() => { events.push('teardown') })
        return new Promise<string>((_, reject) => { rejectFn = reject })
      }
      const props = container.register(svcKey(), fn)

      const p1 = container.resolve(props).catch(() => { events.push('p1-rejected') })
      const p2 = container.resolve(props).catch(() => { events.push('p2-rejected') })

      rejectFn(new Error('fail'))

      await Promise.all([p1, p2])
      expect(events[0]).toBe('teardown')
    })

    it('销毁函数自身抛错也不影响错误通知', async () => {
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => { throw new Error('teardown error') })
        throw new Error('service error')
      }
      const props = container.register(svcKey(), fn)

      await expect(container.resolve(props)).rejects.toThrow('service error')
    })
  })

  describe('shutdown (public) - 手动销毁所有服务', () => {
    it('container.shutdown 时每个 defineService 中注册的 shutdown 都必须被执行', async () => {
      const teardowns = Array.from({ length: 5 }, () => vi.fn())
      const services = teardowns.map((teardown, i) =>
        async (shutdown: (fn: () => void) => void) => {
          shutdown(teardown)
          return `s${i}`
        }
      )

      for (const fn of services) {
        await container.resolve(container.register(svcKey(), fn))
      }

      await container.shutdown()

      for (const t of teardowns) {
        expect(t).toHaveBeenCalledTimes(1)
      }
    })

    it('手动调用 shutdown 后应执行所有已注册的销毁函数', async () => {
      const teardownA = vi.fn()
      const teardownB = vi.fn()

      const fnA = async (shutdown: (fn: () => void) => void) => {
        shutdown(teardownA)
        return 'A'
      }
      const fnB = async (shutdown: (fn: () => void) => void) => {
        shutdown(teardownB)
        return 'B'
      }

      await container.resolve(container.register(svcKey(), fnA))
      await container.resolve(container.register(svcKey(), fnB))

      expect(teardownA).not.toHaveBeenCalled()
      expect(teardownB).not.toHaveBeenCalled()

      await container.shutdown()

      expect(teardownA).toHaveBeenCalledOnce()
      expect(teardownB).toHaveBeenCalledOnce()
    })

    it('手动 shutdown 按服务注册逆序执行（后注册先销毁）', async () => {
      const order: string[] = []

      const fnA = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => order.push('A'))
        return 'A'
      }
      const fnB = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => order.push('B'))
        return 'B'
      }
      const fnC = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => order.push('C'))
        return 'C'
      }

      await container.resolve(container.register(svcKey(), fnA))
      await container.resolve(container.register(svcKey(), fnB))
      await container.resolve(container.register(svcKey(), fnC))

      await container.shutdown()

      expect(order).toEqual(['C', 'B', 'A'])
    })

    it('单个服务内多个销毁函数也按逆序执行', async () => {
      const order: number[] = []

      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => order.push(1))
        shutdown(() => order.push(2))
        shutdown(() => order.push(3))
        return 'ok'
      }

      await container.resolve(container.register(svcKey(), fn))
      await container.shutdown()

      expect(order).toEqual([3, 2, 1])
    })

    it('shutdown 期间才完成启动并注册 teardown 的服务也会被关掉（竞态覆盖）', async () => {
      const teardownFast = vi.fn()
      const teardownSlow = vi.fn()
      const fnFast = (shutdown: (fn: () => void) => void) => {
        shutdown(teardownFast)
        return 'fast'
      }
      const fnSlow = async (shutdown: (fn: () => void) => void) => {
        await new Promise<void>(r => setImmediate(r))
        shutdown(teardownSlow)
        return 'slow'
      }

      const pFast = container.resolve(container.register(svcKey(), fnFast))
      const pSlow = container.resolve(container.register(svcKey(), fnSlow))
      await pFast
      // pSlow 尚未 resolve；shutdown 先处理 fast，再 yield 一次，slow 在 setImmediate 里注册 teardown，应被下一轮循环处理
      const shutdownPromise = container.shutdown()
      await pSlow
      await shutdownPromise

      expect(teardownFast).toHaveBeenCalledOnce()
      expect(teardownSlow).toHaveBeenCalledOnce()
    })

    it('shutdown 后重复调用不会再次执行销毁函数', async () => {
      const teardown = vi.fn()
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(teardown)
        return 'ok'
      }

      await container.resolve(container.register(svcKey(), fn))
      await container.shutdown()
      await container.shutdown()

      expect(teardown).toHaveBeenCalledOnce()
    })

    it('没有注册销毁函数时调用 shutdown 不报错', async () => {
      await expect(container.shutdown()).resolves.toBeUndefined()
    })

    it('shutdown 支持异步销毁函数', async () => {
      const order: number[] = []

      const fn = async (shutdown: (fn: () => Promise<void>) => void) => {
        shutdown(async () => {
          await new Promise(r => setTimeout(r, 10))
          order.push(1)
        })
        shutdown(async () => {
          order.push(2)
        })
        return 'ok'
      }

      await container.resolve(container.register(svcKey(), fn))
      await container.shutdown()

      expect(order).toEqual([2, 1])
    })
  })

  describe('lifecycle / timeout / graph', () => {
    it('生命周期应按 init -> ready -> stopping -> stopped 变化', async () => {
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => { })
        return 'ok'
      }
      const props = container.register(svcKey(), fn)
      expect(container.getLifecycle(props.key)).toBeUndefined()
      await container.resolve(props)
      expect(container.getLifecycle(props.key)).toBe('ready')
      await container.shutdown()
      expect(container.getLifecycle(props.key)).toBe('stopped')
    })

    it('启动超时应抛错', async () => {
      const c = new Container({ startTimeoutMs: 20 })
      const fn = async () => {
        await new Promise(r => setTimeout(r, 50))
        return 'late'
      }
      await expect(c.resolve(c.register(svcKey(), fn))).rejects.toThrow('service startup timeout')
    })

    it('应可订阅可观测事件', async () => {
      const c = new Container()
      const events: string[] = []
      const off = c.on((e) => events.push(e.type))
      const fn = async (shutdown: (fn: () => void) => void) => {
        shutdown(() => { })
        return 'ok'
      }
      await c.resolve(c.register(svcKey(), fn))
      await c.shutdown()
      off()
      expect(events).toContain('service:init')
      expect(events).toContain('service:ready')
      expect(events).toContain('container:shutdown:start')
      expect(events).toContain('container:shutdown:done')
    })

    it('应记录依赖图与启动顺序', async () => {
      const dep = container.register(svcKey(), async () => 'dep')
      const root = container.register(svcKey(), async (shutdown) => {
        shutdown(() => { })
        await container.resolve(dep)
        return 'root'
      })
      await container.resolve(root)

      const graph = container.getDependencyGraph()
      expect(graph.edges).toEqual(expect.arrayContaining([{ from: root.key, to: dep.key }]))
      expect(container.getStartupOrder()).toEqual(expect.arrayContaining([root.key]))
    })

    it('应检测循环依赖', async () => {
      let aProps: any
      let bProps: any

      const a = async () => {
        await container.resolve(bProps)
        return 'a'
      }
      const b = async () => {
        await container.resolve(aProps)
        return 'b'
      }

      aProps = container.register(svcKey(), a)
      bProps = container.register(svcKey(), b)

      await expect(container.resolve(aProps)).rejects.toThrow('circular dependency detected')
    })
  })

  describe('hasService - 检查服务是否已注册', () => {
    it('未注册的 key 应返回 false', () => {
      expect(container.hasService('missing')).toBe(false)
    })

    it('已注册的 key 应返回 true', () => {
      const key = 'my-svc'
      const fn = () => 'hello'
      container.register(key, fn)
      expect(container.hasService(key)).toBe(true)
    })

    it('不同 key 互不影响', () => {
      const k1 = 'a'
      const k2 = 'b'
      const fn1 = () => 'a'
      const fn2 = () => 'b'
      container.register(k1, fn1)
      expect(container.hasService(k1)).toBe(true)
      expect(container.hasService(k2)).toBe(false)
    })
  })

  describe('hasMeta - 检查服务是否已运行', () => {
    it('未运行的服务应返回 false', () => {
      const fn = () => 'hello'
      const props = container.register(svcKey(), fn)
      expect(container.hasMeta(props.key)).toBe(false)
    })

    it('已运行的服务应返回 true', async () => {
      const fn = () => 'hello'
      const props = container.register(svcKey(), fn)
      await container.resolve(props)
      expect(container.hasMeta(props.key)).toBe(true)
    })

    it('运行中的服务也应返回 true', () => {
      const fn = () => new Promise(() => { })
      const props = container.register(svcKey(), fn)
      container.resolve(props)
      expect(container.hasMeta(props.key)).toBe(true)
    })

    it('不存在的 key 应返回 false', () => {
      expect(container.hasMeta(Symbol('no-such'))).toBe(false)
    })
  })

  describe('getMetaByKey - 获取服务元数据', () => {
    it('未运行的服务应返回 undefined', () => {
      const fn = () => 'hello'
      const props = container.register(svcKey(), fn)
      expect(container.getMetaByKey(props.key)).toBeUndefined()
    })

    it('运行中的服务元数据 status 应为 0', () => {
      const fn = () => new Promise(() => { })
      const props = container.register(svcKey(), fn)
      container.resolve(props)
      const meta = container.getMetaByKey(props.key)
      expect(meta).toBeDefined()
      expect(meta!.status).toBe(0)
    })

    it('运行成功的服务元数据 status 应为 1，且包含正确的 value', async () => {
      const fn = () => 'result'
      const props = container.register(svcKey(), fn)
      await container.resolve(props)
      const meta = container.getMetaByKey(props.key)
      expect(meta).toBeDefined()
      expect(meta!.status).toBe(1)
      expect(meta!.value).toBe('result')
    })

    it('运行失败的服务元数据 status 应为 -1，且包含 error', async () => {
      const error = new Error('oops')
      const fn = () => Promise.reject(error)
      const props = container.register(svcKey(), fn)
      await container.resolve(props).catch(() => { })
      const meta = container.getMetaByKey(props.key)
      expect(meta).toBeDefined()
      expect(meta!.status).toBe(-1)
      expect(meta!.error).toBe(error)
    })

    it('不存在的 key 应返回 undefined', () => {
      expect(container.getMetaByKey('no-such-key')).toBeUndefined()
    })
  })

  describe('off - 移除事件监听器', () => {
    it('off 移除监听器后不再收到事件', async () => {
      const listener = vi.fn()
      container.on(listener)
      container.off(listener)

      const fn = async () => 'test'
      await container.resolve(container.register('off-verify', fn))
      await container.shutdown()

      expect(listener).not.toHaveBeenCalled()
    })

    it('on 返回的取消函数也可以取消监听', async () => {
      const listener = vi.fn()
      const unsub = container.on(listener)
      unsub()

      const fn = async () => 'test'
      await container.resolve(container.register('off-unsub', fn))
      await container.shutdown()

      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('defineService / loadService - 便捷函数', () => {
    it('defineService 返回包含 key、fn、flag 的对象', () => {
      const props = defineService('ds-test', async () => 'defined')
      expect(props.key).toBe('ds-test')
      expect(typeof props.fn).toBe('function')
      expect(isService(props)).toBe(true)
    })

    it('loadService 根据 props 解析服务', async () => {
      const props = defineService('ls-test', async () => 'loaded')
      const result = await loadService(props)
      expect(result).toBe('loaded')
    })

    it('defineService + loadService 完整流程', async () => {
      const props = defineService('ds-ls-test', async () => 'complete')
      const result = await loadService(props)
      expect(result).toBe('complete')
    })
  })

  describe('hasPath - 依赖图遍历', () => {
    it('多层级依赖检测非循环时返回 false', async () => {
      // 建立 A → B → C 依赖链
      const cProps = container.register('c-hp', async () => 'c')
      const bProps = container.register('b-hp', async () => {
        await container.resolve(cProps)
        return 'b'
      })
      const aProps = container.register('a-hp', async () => {
        await container.resolve(bProps)
        return 'a'
      })
      // 正常解析 A，建立依赖链
      await container.resolve(aProps)

      // 再注册 X → A，触发 hasPath(A, X)
      // hasPath 从 A 开始遍历依赖链 (A→B→C)，C 无更多依赖，返回 false
      const xProps = container.register('x-hp', async () => {
        await container.resolve(aProps)
        return 'x'
      })
      const result = await container.resolve(xProps)
      expect(result).toBe('x')
    })
  })

  describe('自循环依赖检测', () => {
    it('service 中 resolve 自身时检测到自循环', async () => {
      const props = container.register('self-ref', async () => {
        await container.resolve(props)
        return 'self'
      })
      await expect(container.resolve(props)).rejects.toThrow('circular dependency detected')
    })
  })

  describe('formatServiceKey - 格式化服务 key', () => {
    it('字符串 key 原样返回', () => {
      expect(formatServiceKey('hello')).toBe('hello');
    });

    it('symbol key 返回 String(symbol)', () => {
      const sym = Symbol('test-svc');
      const result = formatServiceKey(sym);
      expect(result).toBe(String(sym));
      expect(result).toContain('test-svc');
    });
  });

  describe('重复依赖追踪', () => {
    it('从同一父服务 resolve 子服务两次不应报错', async () => {
      const c = new Container();
      const childProps = c.register('child-dup', async () => 'child');
      const parentProps = c.register('parent-dup', async () => {
        // First resolve — creates dependency edge
        const r1 = await c.resolve(childProps);
        // Second resolve — trackDependency sees existing edge, hits false branch
        const r2 = await c.resolve(childProps);
        return [r1, r2];
      });

      const result = await c.resolve(parentProps);
      expect(result).toEqual(['child', 'child']);
    });
  });

  describe('边缘分支覆盖', () => {
    it('nextOrdinal 超过 MAX_SAFE_INTEGER 后重置为 1', () => {
      const c = new Container();
      (c as any)['keyOrder'] = Number.MAX_SAFE_INTEGER - 1;
      c.register('overflow-test', async () => 'ok');
      // ++this.keyOrder → MAX_SAFE_INTEGER → overflow check resets to 1
      expect((c as any)['keyOrder']).toBe(1);
    });

    it('diamond 依赖中 hasPath visited 覆盖', async () => {
      const c = new Container();
      // B → D, C → D（diamond），A → B, A → C
      const dProps = c.register('d', async () => 'd');
      const cProps = c.register('c', async () => {
        await c.resolve(dProps);
        return 'c';
      });
      const bProps = c.register('b', async () => {
        await c.resolve(dProps);
        return 'b';
      });
      const aProps = c.register('a', async () => {
        await c.resolve(bProps);
        await c.resolve(cProps);
        return 'a';
      });
      // 建立 A → B → D, A → C → D 的 diamond
      await c.resolve(aProps);

      // 再注册 X → A，触发 hasPath(A, X) 遍历 diamond
      // 遍历 from=A → [B, C] → B→D → C→D 时 D 已在 visited 中
      const xProps = c.register('x', async () => {
        await c.resolve(aProps);
        return 'x';
      });
      const result = await c.resolve(xProps);
      expect(result).toBe('x');
    });
  });

  describe('isService - 判断是否为服务', () => {
    it('通过 register 返回的对象应判定为服务', () => {
      const fn = () => 'hello'
      const props = container.register(svcKey(), fn)
      expect(isService(props)).toBe(true)
    })

    it('手动构造的对象（缺少正确 flag）应判定为非服务', () => {
      const fake = { key: 'x', fn: () => 'hello', flag: Symbol('fake') }
      expect(isService(fake as any)).toBe(false)
    })

    it('缺少 key 字段应判定为非服务', () => {
      const fn = () => 'hello'
      const props = container.register(svcKey(), fn)
      const broken = { ...props, key: undefined }
      expect(isService(broken as any)).toBe(false)
    })

    it('缺少 fn 字段应判定为非服务', () => {
      const fn = () => 'hello'
      const props = container.register(svcKey(), fn)
      const broken = { ...props, fn: undefined }
      expect(isService(broken as any)).toBe(false)
    })

    it('fn 为非函数类型应判定为非服务', () => {
      const fn = () => 'hello'
      const props = container.register(svcKey(), fn)
      const broken = { ...props, fn: 'not-a-function' }
      expect(isService(broken as any)).toBe(false)
    })

    it('完全无关的对象应判定为非服务', () => {
      expect(isService({} as any)).toBe(false)
      expect(isService({ key: 'k' } as any)).toBe(false)
      expect(isService({ key: 'k', fn: () => { }, flag: 'wrong' } as any)).toBe(false)
    })
  })
})
