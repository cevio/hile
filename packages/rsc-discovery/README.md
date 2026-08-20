# @hile/rsc-discovery

Transport-neutral lifecycle coordination for dynamically discovered Hile RSC plugins.

`RscDiscoveryManager` treats service discovery as the source of truth: the selected compatible candidate is
deployed automatically, replacement builds are switched transactionally, failed replacements leave the working
build active, and missing services are retired after a configurable grace window. It contains no Registry,
filesystem, Next.js, or business-specific logic.

Application projects normally consume this indirectly through `HileRscDiscoveryHost` from `@hile/rsc-discovery-hile`. Use `RscDiscoveryManager` directly only for another registry/transport adapter. Candidate failures are isolated per plugin, existing deployments survive failed upgrades, and shutdown/retirement are lifecycle operations rather than route behavior. See the [RSC architecture reference](../../docs/ai/packages/rsc.md).

The v1 announcement schema accepts either signed authentication metadata or the explicit `{ scheme: 'trusted-internal' }` marker. The latter carries no pretend key or signature and is valid only when every publisher able to reach the internal discovery transport belongs to the deployment trust boundary.

Upgrade readers before publishers when moving a live deployment to `trusted-internal`: new readers remain compatible with signed announcements, while older readers reject the unsigned authentication shape.
