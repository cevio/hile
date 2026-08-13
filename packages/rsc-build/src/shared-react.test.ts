import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { HILE_RSC_SHARED_REACT_EXPORTS } from './shared-react';

describe('shared React client shim', () => {
  it('exposes every supported public named export of the pinned React runtime', () => {
    const ignored = new Set([
      'default',
      'module.exports',
      '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
      '__COMPILER_RUNTIME',
    ]);
    const publicRuntimeExports = Object.keys(React)
      .filter((name) => !ignored.has(name))
      .sort();

    expect([...HILE_RSC_SHARED_REACT_EXPORTS].sort()).toEqual(publicRuntimeExports);
  });
});
