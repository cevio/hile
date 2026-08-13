import { HILE_REMOTE_CLIENT_REFERENCE } from '@hile/rsc/protocol';
import type { RscGraphEntry } from './module-graph';

export function createClientReferenceSource(entry: RscGraphEntry): string {
  const lines = [
    `import React from 'react';`,
    `import { registerClientReference as __hileRegisterClientReference } from 'react-server-dom-webpack/server.node';`,
    `const __hileRemoteClientBoundary = __hileRegisterClientReference(function () {`,
    `  throw new Error('RemoteClientBoundary cannot execute on the plugin RSC server');`,
    `}, ${JSON.stringify(HILE_REMOTE_CLIENT_REFERENCE)}, 'default');`,
  ];
  for (const exportName of entry.exports) {
    const local = exportName === 'default' ? '__hileDefault' : `__hile_${exportName}`;
    lines.push(
      `function ${local}(props) {`,
      `  return React.createElement(__hileRemoteClientBoundary, {`,
      `    pluginId: ${JSON.stringify(entry.pluginId)},`,
      `    buildId: ${JSON.stringify(entry.buildId)},`,
      `    referenceId: ${JSON.stringify(`${entry.referenceBase}#${exportName}`)},`,
      `    exportName: ${JSON.stringify(exportName)},`,
      `    props,`,
      `  });`,
      `}`,
      exportName === 'default' ? `export default ${local};` : `export { ${local} as ${exportName} };`,
    );
  }
  return lines.join('\n');
}

export function createServerReferenceSource(entry: RscGraphEntry, implementationSpecifier: string): string {
  const lines = [
    `import * as __hileImplementation from ${JSON.stringify(implementationSpecifier)};`,
    `import { registerServerReference as __hileRegisterServerReference } from 'react-server-dom-webpack/server.node';`,
  ];
  for (const exportName of entry.exports) {
    const local = exportName === 'default' ? '__hileDefault' : `__hile_${exportName}`;
    lines.push(
      `const ${local} = __hileRegisterServerReference(__hileImplementation[${JSON.stringify(exportName)}], ${JSON.stringify(`${entry.referenceBase}#${exportName}`)}, ${JSON.stringify(exportName)});`,
      exportName === 'default' ? `export default ${local};` : `export { ${local} as ${exportName} };`,
    );
  }
  return lines.join('\n');
}

export function createBrowserServerReferenceSource(entry: RscGraphEntry): string {
  const lines = [
    `const __hileCreateServerReference = globalThis.__HILE_RSC_CREATE_SERVER_REFERENCE__;`,
    `if (!__hileCreateServerReference) throw new Error('Hile RSC Host did not install the Server Function runtime');`,
  ];
  for (const exportName of entry.exports) {
    const local = exportName === 'default' ? '__hileDefault' : `__hile_${exportName}`;
    lines.push(
      `const ${local} = __hileCreateServerReference(${JSON.stringify(`${entry.referenceBase}#${exportName}`)}, ${JSON.stringify(exportName)});`,
      exportName === 'default' ? `export default ${local};` : `export { ${local} as ${exportName} };`,
    );
  }
  return lines.join('\n');
}
