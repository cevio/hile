import type { RscClientNavigation } from './navigation-types';

interface RscNavigationInstallation {
  navigation: RscClientNavigation;
  active: boolean;
}

interface RscNavigationRuntimeState {
  installations: RscNavigationInstallation[];
}

const runtimeStateKey = Symbol.for('@hile/rsc/client/navigation/runtime');

function runtimeState(): RscNavigationRuntimeState {
  const scope = globalThis as typeof globalThis & {
    [runtimeStateKey]?: RscNavigationRuntimeState;
  };
  return scope[runtimeStateKey] ??= { installations: [] };
}

export function getRscNavigationRuntime(): RscClientNavigation | undefined {
  return runtimeState().installations.at(-1)?.navigation;
}

/** Installs one public Host adapter and returns an ownership-safe cleanup function. */
export function installRscNavigationRuntime(navigation: RscClientNavigation): () => void {
  for (const operation of ['push', 'replace', 'refresh', 'prefetch'] as const) {
    if (typeof navigation[operation] !== 'function') {
      throw new TypeError(`RSC navigation ${operation} must be a function`);
    }
  }
  const installations = runtimeState().installations;
  const installation = { navigation, active: true };
  installations.push(installation);
  return () => {
    if (!installation.active) return;
    installation.active = false;
    const index = installations.indexOf(installation);
    if (index !== -1) installations.splice(index, 1);
  };
}
