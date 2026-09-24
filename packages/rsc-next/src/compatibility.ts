import nextPackage from 'next/package.json' with { type: 'json' };
import reactPackage from 'react/package.json' with { type: 'json' };
import reactDomPackage from 'react-dom/package.json' with { type: 'json' };

export const HILE_RSC_NEXT_COMPATIBILITY = Object.freeze({
  next: '16.3.0',
  react: '19.2.8',
  reactDom: '19.2.8',
});

export interface RscNextRuntimeVersions {
  next: string;
  react: string;
  reactDom: string;
}

export function assertRscNextCompatibility(
  runtime: RscNextRuntimeVersions = {
    next: nextPackage.version,
    react: reactPackage.version,
    reactDom: reactDomPackage.version,
  },
): void {
  if (
    runtime.next !== HILE_RSC_NEXT_COMPATIBILITY.next
    || runtime.react !== HILE_RSC_NEXT_COMPATIBILITY.react
    || runtime.reactDom !== HILE_RSC_NEXT_COMPATIBILITY.reactDom
  ) {
    throw new Error(
      `Unsupported RSC Next runtime: Next ${runtime.next} + React ${runtime.react} + ReactDOM ${runtime.reactDom}; `
      + `supported tuple is Next ${HILE_RSC_NEXT_COMPATIBILITY.next} `
      + `+ React ${HILE_RSC_NEXT_COMPATIBILITY.react} `
      + `+ ReactDOM ${HILE_RSC_NEXT_COMPATIBILITY.reactDom}`,
    );
  }
}
