import { describe, expect, it } from 'vitest';
import {
  decodeRscServerFunctionValue,
  encodeRscServerFunctionValue,
} from './codec';

describe('RSC server function wire codec', () => {
  it('round-trips React-supported scalar and structured values', async () => {
    const value = {
      undefined,
      bigint: 9007199254740993n,
      date: new Date('2026-08-13T00:00:00.000Z'),
      map: new Map<unknown, unknown>([['answer', 42], [7, { nested: true }]]),
      set: new Set(['a', 'b']),
      arrayBuffer: Uint8Array.from([0, 127, 255]).buffer,
      typed: new Int16Array([-2, 7, 1024]),
      symbol: Symbol.for('hile.rsc.fixture'),
      specialNumbers: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
      nested: [{ ok: true }, null, 'value'],
    };

    const decoded = await decodeRscServerFunctionValue(
      await encodeRscServerFunctionValue(value),
    ) as typeof value;

    expect(decoded.undefined).toBeUndefined();
    expect(decoded.bigint).toBe(value.bigint);
    expect(decoded.date).toEqual(value.date);
    expect([...decoded.map.entries()]).toEqual([...value.map.entries()]);
    expect([...decoded.set]).toEqual([...value.set]);
    expect([...new Uint8Array(decoded.arrayBuffer)]).toEqual([0, 127, 255]);
    expect(decoded.typed).toBeInstanceOf(Int16Array);
    expect([...decoded.typed]).toEqual([-2, 7, 1024]);
    expect(decoded.symbol).toBe(Symbol.for('hile.rsc.fixture'));
    expect(Number.isNaN(decoded.specialNumbers[0])).toBe(true);
    expect(decoded.specialNumbers.slice(1, 3)).toEqual([Infinity, -Infinity]);
    expect(Object.is(decoded.specialNumbers[3], -0)).toBe(true);
    expect(decoded.nested).toEqual(value.nested);
  });

  it('round-trips FormData order, duplicate fields, and files', async () => {
    const formData = new FormData();
    formData.append('tag', 'first');
    formData.append('tag', 'second');
    formData.append('upload', new File([Uint8Array.from([1, 2, 3])], 'fixture.bin', {
      type: 'application/octet-stream',
      lastModified: 123,
    }));

    const decoded = await decodeRscServerFunctionValue(
      await encodeRscServerFunctionValue(formData),
    ) as FormData;

    expect(decoded.getAll('tag')).toEqual(['first', 'second']);
    const file = decoded.get('upload');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('fixture.bin');
    expect((file as File).type).toBe('application/octet-stream');
    expect([...new Uint8Array(await (file as File).arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('awaits promises nested in arguments', async () => {
    const decoded = await decodeRscServerFunctionValue(
      await encodeRscServerFunctionValue({ value: Promise.resolve(9) }),
    );
    expect(decoded).toEqual({ value: 9 });
  });

  it('rejects cycles, class instances, functions, and non-global symbols', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class Fixture {}

    await expect(encodeRscServerFunctionValue(cyclic)).rejects.toThrow('cyclic');
    await expect(encodeRscServerFunctionValue(new Fixture())).rejects.toThrow('plain object');
    await expect(encodeRscServerFunctionValue(() => undefined)).rejects.toThrow('function');
    await expect(encodeRscServerFunctionValue(Symbol('private'))).rejects.toThrow('global');
  });

  it('rejects malformed and unknown wire envelopes', async () => {
    await expect(decodeRscServerFunctionValue(null as never)).rejects.toThrow('wire value');
    await expect(decodeRscServerFunctionValue({ type: 'future', value: 1 } as never))
      .rejects.toThrow('wire type');
    await expect(decodeRscServerFunctionValue({ type: 'date', value: 'invalid' } as never))
      .rejects.toThrow('date');
    await expect(decodeRscServerFunctionValue({ type: 'array-buffer', value: '!!!!' }))
      .rejects.toThrow('base64');
  });

  it('bounds nesting depth and total decoded nodes', async () => {
    let deep: any = { type: 'null' };
    for (let index = 0; index < 80; index++) deep = { type: 'array', value: [deep] };
    await expect(decodeRscServerFunctionValue(deep)).rejects.toThrow('depth');

    const wide = { type: 'array', value: Array.from({ length: 10_001 }, () => ({ type: 'null' })) };
    await expect(decodeRscServerFunctionValue(wide)).rejects.toThrow('node');
  });
});
