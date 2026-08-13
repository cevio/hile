import { describe, expect, it } from 'vitest';
import { inspectModule } from './directives';

describe('inspectModule', () => {
  it.each([
    `'use client';\nexport default function A() {}`,
    `"use client"\nexport const A = 1`,
    `// comment\n'use client';\nexport { A } from './a'`,
    `/* license */\n'use client';\nexport class A {}`,
  ])('recognizes use client in the directive prologue', (source) => {
    expect(inspectModule(source, 'module.tsx').useClient).toBe(true);
  });

  it.each([
    `const value = 1;\n'use client';\nexport default value`,
    `function useClient() {}\nexport { useClient }`,
    `const text = 'use client';\nexport default text`,
    "`use client`; export default 1",
    `'use server';\nexport async function action() {}`,
  ])('does not treat non-directives as a client boundary', (source) => {
    expect(inspectModule(source, 'module.tsx').useClient).toBe(false);
  });

  it('collects default, named declarations, variable bindings, and export specifiers', () => {
    const source = `
      'use client';
      export default function Counter() {}
      export function Named() {}
      export class Widget {}
      export const alpha = 1, beta = 2;
      const local = 3;
      export { local as renamed };
      export { Other as forwarded } from './other';
    `;

    expect(inspectModule(source, 'module.tsx').exports).toEqual([
      'default', 'Named', 'Widget', 'alpha', 'beta', 'renamed', 'forwarded',
    ]);
  });

  it('rejects export star because stable client reference names cannot be inferred locally', () => {
    expect(() => inspectModule(
      `'use client'; export * from './other'`,
      'module.tsx',
    )).toThrow('export *');
  });

  it('rejects a client entry without exports', () => {
    expect(() => inspectModule(`'use client'; const local = 1`, 'module.tsx'))
      .toThrow('must export');
  });

  it('reports parser diagnostics with the filename', () => {
    expect(() => inspectModule(`'use client'; export const =`, 'broken.tsx'))
      .toThrow('broken.tsx');
  });
});
