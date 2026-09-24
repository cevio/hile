import { describe, expect, it } from 'vitest';
import { HILE_RSC_DOCUMENT_METADATA_LIMITS } from './constants';
import { validateRscDocumentMetadata } from './document-metadata';

describe('validateRscDocumentMetadata', () => {
  it('returns a detached frozen JSON value', () => {
    const source = { title: 'Page', nested: { index: true }, values: [1, null] };
    const result = validateRscDocumentMetadata(source);

    source.nested.index = false;
    expect(result).toEqual({ title: 'Page', nested: { index: true }, values: [1, null] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nested)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
  });

  it.each([
    { title: undefined },
    { title: Number.NaN },
    { title: new URL('https://example.com') },
    { title: () => 'Page' },
  ])('rejects values that are not bounded JSON data', (value) => {
    expect(() => validateRscDocumentMetadata(value)).toThrow();
  });

  it('rejects sparse arrays without allocating from an unbounded length', () => {
    const sparse = new Array(2);
    sparse[1] = 'value';
    expect(() => validateRscDocumentMetadata({ sparse })).toThrow('sparse arrays');

    const oversized: unknown[] = [];
    oversized.length = HILE_RSC_DOCUMENT_METADATA_LIMITS.nodes + 1;
    expect(() => validateRscDocumentMetadata({ oversized })).toThrow('node count');
  });

  it('rejects cycles and excessive depth', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateRscDocumentMetadata(cyclic)).toThrow('cyclic');

    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 17; index++) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }
    expect(() => validateRscDocumentMetadata(root)).toThrow('depth');
  });

  it('enforces node, key and UTF-8 string budgets', () => {
    expect(() => validateRscDocumentMetadata({
      values: Array.from(
        { length: HILE_RSC_DOCUMENT_METADATA_LIMITS.nodes },
        () => null,
      ),
    })).toThrow('node count');
    expect(() => validateRscDocumentMetadata({
      ['k'.repeat(HILE_RSC_DOCUMENT_METADATA_LIMITS.keyLength + 1)]: true,
    })).toThrow('key');
    expect(() => validateRscDocumentMetadata({
      title: '🙂'.repeat(HILE_RSC_DOCUMENT_METADATA_LIMITS.stringBytes / 4 + 1),
    })).toThrow('string bytes');
  });
});
