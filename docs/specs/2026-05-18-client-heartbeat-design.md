# Client Heartbeat Design

> **Goal:** Unify heartbeat from per-Application to per-Client, so all WebSocket connections
> (not just Registry) have liveness detection.
>
> **Principle:** Heartbeat is the responsibility of the *connection* (Client), not the *application*
> (Application/Registry). 10s interval, 20s timeout.

## Architecture

```
Before: heartbeat only between Application ⇄ Registry
  Application (timer 10s) ──push("/-/heartbeat")──► Registry (scan 1s, timeout 20s)
  Consumer                                        Provider
     │  (no heartbeat)                                │
     └─────────── WebSocket (silent) ─────────────────┘
     Process kill -9 → half-open connection lingers

After: every Client sends heartbeats bidirectionally
  Client A                              Client B
     │  10s push("/-/heartbeat")         │
     ├──────────────────────────────────►│  exec() intercept → update lastHeartbeat
     │◄──────────────────────────────────┤  exec() intercept → update lastHeartbeat
     │  10s push("/-/heartbeat")         │
     │                                    │
     │  lastHeartbeat > 20s stale        │
     │  → dispose() → WebSocket close    │
     │  → cleanup local state            │
```

## Changes

### 1. Client — add heartbeat

New fields and constants on `Client`:

```typescript
export class Client extends MessageWs {
  // Heartbeat constants (overridable via env vars)
  private static readonly HEARTBEAT_INTERVAL =
    Number(process.env.MICRO_HEARTBEAT_INTERVAL) || 10_000;
  private static readonly HEARTBEAT_TIMEOUT =
    Number(process.env.MICRO_HEARTBEAT_TIMEOUT) || 20_000;
  private static readonly CHECK_INTERVAL =
    Number(process.env.MICRO_HEARTBEAT_CHECK_INTERVAL) || 5_000;

  private lastHeartbeat = Date.now();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private checkTimer?: ReturnType<typeof setInterval>;
}
```

Timer lifecycle in constructor / `dispose()`:

```
constructor: lastHeartbeat = Date.now() → startHeartbeat()
startHeartbeat:
  ├── heartbeatTimer (10s): _push({ url: '/-/heartbeat', data: {} })
  └── checkTimer (5s):      if now - lastHeartbeat > 20s → dispose()

dispose():
  ├── clearInterval(heartbeatTimer)
  ├── clearInterval(checkTimer)
  └── (unchanged) socket.close(), listener cleanup, stacks cleanup
```

Intercept heartbeat in `exec()` — no route dispatch:

```typescript
protected async exec(data: { url: string; data: any }): Promise<any> {
  if (data.url === '/-/heartbeat') {
    this.lastHeartbeat = Date.now();
    return;
  }
  // unchanged
  if (!this._online) throw new Error('Client is not online');
  return this.server.dispatch(data.url, data.data, { client: this });
}
```

### 2. Application — remove heartbeat

Remove from `Application`:

| Item | Why |
|------|-----|
| `HEARTBEAT_INTERVAL` constant | Registry Client handles its own heartbeat |
| `heartbeatTimer` field | No longer needed |
| `startHeartbeat()` / `stopHeartbeat()` | Replaced by Client |
| `listen()` → `this.startHeartbeat()` call | Replaced by Client constructor |
| Teardown → `this.stopHeartbeat()` call | Replaced by Client `dispose()` |

**Reconnect logic is UNCHANGED**:
`Client.dispose()` → WebSocket close → `events.emit('disconnect')`
→ `registry.events.once('disconnect')` fires
→ `this.registry = undefined` → `reconnectToRegistry()` / `scheduleRegistryRetry()`

### 3. Registry — remove standalone heartbeat tracking

Remove from `Registry`:

| Item | Why |
|------|-----|
| `HEARTBEAT_INTERVAL` constant | Client handles detection |
| `HEARTBEAT_TIMEOUT` constant | Client handles detection |
| `heartbeats` Map | Replaced by Client `lastHeartbeat` |
| `connect` event → `heartbeats.set(key, now)` | No longer needed |
| `disconnect` event → `heartbeats.delete(key)` | No longer needed |
| `/-/heartbeat` route handler | Client `exec()` intercepts |
| 1s scan timer in `listen()` | Client self-detects |

**Namespace management is UNCHANGED**:
`Client.dispose()` → WebSocket close → `createClient` close handler
→ `clients.delete(key)` → `events.emit('disconnect', client, extras)`
→ Registry disconnect handler → `namespaces.get(ns).delete(key)` → cleanup

### 4. Backward compatibility

- All existing `Client` constructor signatures remain the same
- All existing `Server`, `Application`, `Registry` public APIs remain the same
- Only behavior change is that **every** connection now has heartbeats
- Existing connection timeout flow unchanged
- Existing disconnect/reconnect flow unchanged

## Test Plan

### Existing tests to adapt

| Test | Change |
|------|--------|
| `keeps client alive when heartbeats arrive on time` | Remove `heartbeats` map check; keep `clients` check |
| `disconnects client that stops sending heartbeats` | Use `MICRO_HEARTBEAT_TIMEOUT=3000 MICRO_HEARTBEAT_CHECK_INTERVAL=500` env vars |

### New integration tests

| Test | Scenario |
|------|----------|
| Peer timeout detection | Consumer ↔ Provider, simulate Provider death, verify Consumer Client self-disposes |
| Bidirectional no-timeout | Verify both Clients stay alive for 30s+ under normal conditions |
| Registry reconnect via Client heartbeat | Application connects to Registry, kill Registry, verify auto-reconnect |

## Edge Cases

- **Concurrent timeout**: Both Clients may detect timeout simultaneously. `dispose()` is idempotent
  (`clearInterval` safe, `socket.close()` safe in non-OPEN states).
- **Process crash (kill -9)**: Surviving side's Client detects missing heartbeats within 20s → `dispose()` → cleanup.
- **Network partition**: Both sides detect timeout within 20s, both clean up independently.
- **Flapping**: Reconnect logic (`scheduleRegistryRetry` with 3s delay) unchanged.
