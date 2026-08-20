# @hile/rsc-build

Production build tooling for `@hile/rsc`: directive analysis, immutable plugin compilation, shared React client shims, build configuration, and the `hile-rsc` artifact CLI. It has no service lifecycle or development watcher responsibilities.

Builds are transactional: all graphs and the manifest are completed in a sibling staging directory and atomically published only after success. A failed build leaves the requested immutable output directory empty and retryable for the same build ID.

`RscModuleGraph` is shared by production and incremental compilation. Reference source generation and artifact assembly live in separate modules, so directive semantics, chunk manifests, CSS artifacts, integrity values and Server Function bundles have one implementation.

## Use

```bash
hile-rsc build
hile-rsc inspect
hile-rsc verify
```

The common commands default to `hile-rsc.json`, `.hile-rsc`, and the runtime tuple supported by the installed `@hile/rsc`. Explicit paths, `--config`, and the complete `--react`/`--react-dom`/`--rsc` tuple remain available for automation and compatibility checks.

`buildId` is the immutable identity for one deployment. When omitted in config, it is auto-generated and can be overridden by `RSC_BUILD_ID`; output is placed under the configured `outdir` with the resolved `buildId`. `inspect` and `verify` accept either one artifact directory or its build root and select the newest generated build. An explicit `buildId` keeps the existing exact-`outdir` behavior. The validated config, directive rules, artifact layout, and full Host/plugin walkthrough are documented in [`docs/ai/packages/rsc.md`](../../docs/ai/packages/rsc.md) and [`docs/ai/recipes/rsc-plugin-host.md`](../../docs/ai/recipes/rsc-plugin-host.md).

Optional `metadata` is validated and emitted into the same immutable `plugin.json`. Navigation paths must reference declared plugin routes; public URL and visibility policy remain Host-owned. `build`, `inspect`, and `verify` expose the canonical metadata for automation.
