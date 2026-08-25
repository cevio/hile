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
    [`"use server"\nexport const save = defineRscServerFunction(async (_api, value) => value)`, ['save']],
    [`// comment\n'use server';\nexport default defineRscServerFunction(async () => 1)`, ['default']],
    [`'use server';\nconst save = defineRscServerFunction(async () => 1); export { save }`, ['save']],
  ])('recognizes use server modules and their callable exports', (source, exports) => {
    const inspection = inspectModule(source, 'actions.ts');
    expect(inspection.useServer).toBe(true);
    expect(inspection.exports).toEqual(exports);
  });

  it.each([
    `const value = 1;\n'use client';\nexport default value`,
    `function useClient() {}\nexport { useClient }`,
    `const text = 'use client';\nexport default text`,
    "`use client`; export default 1",
    `'use server';\nexport const action = defineRscServerFunction(async () => 1)`,
  ])('does not treat non-directives as a client boundary', (source) => {
    expect(inspectModule(source, 'module.tsx').useClient).toBe(false);
  });

  it('rejects modules that declare both client and server boundaries', () => {
    expect(() => inspectModule(
      `'use client';\n'use server';\nexport const save = defineRscServerFunction(async () => 1)`,
      'mixed.ts',
    )).toThrow('both');
  });

  it.each([
    `'use server'; export function save() {}`,
    `'use server'; export const save = () => 1`,
    `'use server'; export async function save() {}`,
    `'use server'; export const save = async () => 1`,
    `'use server'; export class Save {}`,
  ])('requires every use server export to use the explicit definition API', (source) => {
    expect(() => inspectModule(source, 'actions.ts')).toThrow('defineRscServerFunction');
  });

  it('rejects use server re-exports because the local callable cannot be verified', () => {
    expect(() => inspectModule(
      `'use server'; export { save } from './implementation'`,
      'actions.ts',
    )).toThrow('re-export');
    expect(() => inspectModule(
      `'use server'; export * from './implementation'`,
      'actions.ts',
    )).toThrow('export *');
  });

  it('rejects use server modules without callable exports', () => {
    expect(() => inspectModule(`'use server'; const local = async () => 1`, 'actions.ts'))
      .toThrow('must export');
  });

  it('rejects inline use server explicitly instead of silently bundling a closure', () => {
    expect(() => inspectModule(`
      export default function Page() {
        async function save() {
          'use server';
          return 1;
        }
        return save;
      }
    `, 'page.tsx')).toThrow('inline');
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
