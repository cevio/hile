# @hile/rsc-development

Optional development-only orchestration for Hile RSC. It owns persistent incremental compiler sessions, source/config observation, revision state, plugin renderer and model reload, Host activation coordination, SSE, and browser reload. Production services do not need this package.

Compiler output retention is bounded with `maxRevisions` (default 5, minimum 2) and `maxSessions` (default 3, minimum 2). Disposal removes the mutable work directory; immutable revisions are retained only within those configured bounds.

The server, browser, and SSR esbuild contexts are persistent. A server-only edit reuses emitted browser/SSR artifacts when the client input fingerprint and Server Function graph are unchanged. Changes to a Client Boundary, its transitive inputs, CSS, or boundary exports rebuild the client contexts; build-scoped Server Function graphs are rebuilt conservatively for every revision.

## Use

Run `hile-rsc-dev` and start the plugin service with the same state file:

```bash
hile-rsc-dev --config hile-rsc.json --state .hile-rsc/development.json --namespace org.example.plugin.dev --outdir .hile-rsc/development
NODE_OPTIONS=--conditions=react-server RSC_DEVELOPMENT_STATE=.hile-rsc/development.json hile start --dev --env-file .env
```

Bind artifact activation with `bindRscPluginDevelopmentState()`, models with `bindRscModelDevelopment()`, and mount `createRscDevelopmentEventMiddleware()` plus `RscDevelopmentReload` in the Host. Failed builds preserve the previous active revision. This package provides safe full-page reload after activation, not React Fast Refresh state preservation. See the [end-to-end guide](../../docs/ai/recipes/rsc-plugin-host.md#10-development-mode).

Build configuration metadata is copied into every immutable development revision. A metadata config reload creates a new revision, so Host navigation never observes presentation data from a different build than the rendered plugin.
