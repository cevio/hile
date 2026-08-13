import { describe, expect, it } from 'vitest';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as ReactDomClient from 'react-dom/client';
import {
  HILE_RSC_SHARED_REACT_DOM_CLIENT_EXPORTS,
  HILE_RSC_SHARED_REACT_DOM_EXPORTS,
  HILE_RSC_SHARED_REACT_EXPORTS,
} from './shared-react';

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

  it('exposes the pinned ReactDOM runtimes required by component libraries', () => {
    const ignored = new Set(['default', 'module.exports', '__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE']);
    expect([...HILE_RSC_SHARED_REACT_DOM_EXPORTS].sort()).toEqual(
      Object.keys(ReactDom).filter((name) => !ignored.has(name)).sort(),
    );
    expect([...HILE_RSC_SHARED_REACT_DOM_CLIENT_EXPORTS].sort()).toEqual(
      Object.keys(ReactDomClient).filter((name) => !ignored.has(name)).sort(),
    );
  });
});
