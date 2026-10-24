# Micro Registry Read APIs

## Registry Read APIs

`Registry` exposes read-only routes for diagnostics and admin tooling. These routes return
snapshots of current registry state; they do not change service discovery, topic declarations,
subscriptions, or retained config data.

- `/-/namespaces` returns all registered namespaces with peer counts and addresses.
- `/-/namespace/peers` accepts `{ namespace, exclude? }` and returns every peer for one namespace.
- `/-/registry/status` returns registry uptime and counts for clients, namespaces, topics, and config namespaces.
- `/-/registry/snapshot` accepts `{}` and returns a `RegistrySnapshot`: status counts,
  namespace peers, topic metadata with publisher/subscriber addresses, config namespace/key
  indexes, and `observedAt` (Unix milliseconds). The projection is assembled synchronously
  from one Registry state without reading or cloning topic payloads or config values.
- `/-/topics` accepts `{ prefix? }` and returns topic summaries with publisher/subscriber counts and retained/data flags.
- `/-/topic/snapshots` accepts `{ prefix? }` and returns current payload snapshots with
  both `publishers` and `subscribers` address arrays. Existing payload semantics are unchanged.
- `/-/topic/get` accepts `{ topic }` and returns the current topic payload snapshot when the topic exists.
- `/-/configs` returns loaded config namespaces and keys.
- `/-/config/get` accepts `{ namespace, key? }` and returns either a config snapshot or one config value.

For monitoring, use the metadata-only SDK helper on an already listening Application:

```ts
const snapshot = await app.getRegistrySnapshot({ signal })
const topic = snapshot.topics.find(entry => entry.topic === 'registry:example/database')
const subscribers = topic?.subscribers.map(address => ({
  ...address,
  namespaces: snapshot.namespaces
    .filter(entry => entry.peers.some(peer => peer.host === address.host && peer.port === address.port))
    .map(entry => entry.namespace),
})) ?? []
```

Address pairs are the identity: match both host and port, preserve all namespace aliases,
and retain unmatched addresses as unknown peers. Do not infer a service identity from
package dependencies, a shared host, or a subscriber count. Subscriber counts represent
distinct connected addresses, not local callback counts. Registry-owned retained config
topics can have data with no client publishers.

`getRegistrySnapshot()` uses the existing bounded, cancellable framework-control connection;
it rejects when Registry is disconnected and creates no topic subscription. Results are
detached copies. Unsubscribe, disconnect, and normal subscription restoration are reflected
on the next read. `observedAt` describes that snapshot, not a change timestamp or activity
history. Poll using the owning service's lifecycle; there is no additional listener or event
stream. This topology describes Registry registrations and pub/sub roles, not service-to-service
RPC traffic. These APIs belong on the trusted internal network; metadata-only is not an
authorization boundary, and the older payload/config read APIs still return values.

Deploy a Registry version supporting `/-/registry/snapshot` before using the new helper.
The new route and the additive `subscribers` field preserve the older read routes.
