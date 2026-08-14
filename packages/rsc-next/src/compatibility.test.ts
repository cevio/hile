import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HILE_RSC_NEXT_COMPATIBILITY,
  assertRscNextCompatibility,
} from './index';

describe('Next private RSC adapter compatibility', () => {
  it('accepts the installed package tuple used by the decoder', () => {
    expect(() => assertRscNextCompatibility()).not.toThrow();
  });

  it('rejects an unsupported runtime and reports the validated tuple', () => {
    expect(() => assertRscNextCompatibility({
      next: '16.4.0', react: '19.2.8', reactDom: '19.2.8',
    })).toThrow('Next 16.3.0 + React 19.2.8 + ReactDOM 19.2.8');
    expect(() => assertRscNextCompatibility({
      next: '16.3.0', react: '19.2.8', reactDom: '19.2.9',
    })).toThrow('ReactDOM 19.2.8');
    expect(HILE_RSC_NEXT_COMPATIBILITY).toEqual({
      next: '16.3.0', react: '19.2.8', reactDom: '19.2.8',
    });
  });

  it('exact-pins the private Next adapter peer dependency', async () => {
    const packageJson = JSON.parse(await readFile(
      path.resolve(import.meta.dirname, '../package.json'),
      'utf8',
    ));
    expect(packageJson.peerDependencies.next).toBe(HILE_RSC_NEXT_COMPATIBILITY.next);
    expect(packageJson.peerDependencies.react).toBe(HILE_RSC_NEXT_COMPATIBILITY.react);
    expect(packageJson.peerDependencies['react-dom']).toBe(HILE_RSC_NEXT_COMPATIBILITY.reactDom);
  });
});
