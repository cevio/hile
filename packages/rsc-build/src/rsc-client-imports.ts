import type { Plugin } from 'esbuild';

export const HILE_RSC_REMOTE_CLIENT_IMPORT = '@hile/rsc/client/navigation';

/** Lets the directive graph inspect the portable navigation boundary and externalizes other RSC APIs. */
export function createRscServerImportsPlugin(): Plugin {
  return {
    name: 'hile-rsc-server-imports',
    setup(build) {
      build.onResolve({ filter: /^@hile\/rsc(?:\/.*)?$/ }, (args) => {
        if (args.path === HILE_RSC_REMOTE_CLIENT_IMPORT) return undefined;
        return { path: args.path, external: true };
      });
    },
  };
}

/** Restricts independently compiled browser graphs to the explicitly portable RSC client API. */
export function createRscClientImportsPlugin(): Plugin {
  return {
    name: 'hile-rsc-client-imports',
    setup(build) {
      build.onResolve({ filter: /^@hile\/rsc(?:\/.*)?$/ }, (args) => {
        if (args.path === HILE_RSC_REMOTE_CLIENT_IMPORT) return undefined;
        return {
          errors: [{
            text: `Remote RSC client components may only import ${HILE_RSC_REMOTE_CLIENT_IMPORT}`,
          }],
        };
      });
    },
  };
}
