# Micro Registry Read APIs

## Registry Read APIs

`Registry` exposes read-only routes for diagnostics and admin tooling. These routes return
snapshots of current registry state; they do not change service discovery, topic declarations,
subscriptions, or retained config data.

- `/-/namespaces` returns all registered namespaces with peer counts and addresses.
- `/-/namespace/peers` accepts `{ namespace, exclude? }` and returns every peer for one namespace.
- `/-/registry/status` returns registry uptime and counts for clients, namespaces, topics, and config namespaces.
- `/-/topics` accepts `{ prefix? }` and returns topic summaries with publisher/subscriber counts and retained/data flags.
- `/-/topic/get` accepts `{ topic }` and returns the current topic payload snapshot when the topic exists.
- `/-/configs` returns loaded config namespaces and keys.
- `/-/config/get` accepts `{ namespace, key? }` and returns either a config snapshot or one config value.
