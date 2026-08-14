import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  HileMcpError,
  defineMcpPrompt,
  defineMcpProvider,
  defineMcpResource,
  defineMcpTool,
} from './index.js';

describe('MCP capability definitions', () => {
  it('creates deeply immutable definitions without coupling config to handlers', () => {
    const handler = async ({ value }: { value: string }) => ({
      content: [{ type: 'text' as const, text: value }],
    });
    const tool = defineMcpTool({
      name: 'lookup',
      description: 'Looks up a value',
      inputSchema: z.object({ value: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
      execution: { retry: 'idempotent-failover', timeoutMs: 500 },
    }, handler);

    expect(tool.handler).toBe(handler);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.config)).toBe(true);
    expect(Object.isFrozen(tool.config.execution)).toBe(true);
  });

  it('preserves and freezes official capability metadata', () => {
    const icons = [{ src: 'https://example.com/tool.svg', mimeType: 'image/svg+xml', sizes: ['any'] }];
    const meta = { 'io.example/ui': { entry: 'tool.html' } };
    const tool = defineMcpTool({
      name: 'lookup',
      inputSchema: z.object({}),
      icons,
      _meta: meta,
    } as any, async () => ({ content: [] }));
    const resource = defineMcpResource({
      kind: 'static',
      name: 'manual',
      uri: 'hile://manual',
      icons,
      size: 42,
      annotations: { audience: ['assistant'], priority: 0.8 },
      _meta: meta,
      cacheHint: { ttlMs: 60_000, cacheScope: 'public' },
    } as any, async uri => ({ contents: [{ uri: uri.toString(), text: 'manual' }] }));

    icons[0].src = 'https://attacker.example/icon.svg';
    meta['io.example/ui'].entry = 'attacker.html';

    expect((tool.config as any).icons).toEqual([{ src: 'https://example.com/tool.svg', mimeType: 'image/svg+xml', sizes: ['any'] }]);
    expect((tool.config as any)._meta).toEqual({ 'io.example/ui': { entry: 'tool.html' } });
    expect((resource.config as any)).toMatchObject({
      size: 42,
      annotations: { audience: ['assistant'], priority: 0.8 },
      cacheHint: { ttlMs: 60_000, cacheScope: 'public' },
    });
    expect(Object.isFrozen((resource.config as any).annotations.audience)).toBe(true);
    expect(Object.isFrozen((tool.config as any)._meta['io.example/ui'])).toBe(true);
  });

  it('defines completion handlers only for declared prompt and template arguments', () => {
    const complete = async () => ['typescript'];
    const prompt = defineMcpPrompt({
      name: 'review',
      argsSchema: z.object({ language: z.string() }),
      completions: { language: complete },
    }, async () => ({ messages: [] }));
    const resource = defineMcpResource({
      kind: 'template',
      name: 'manual',
      uriTemplate: 'hile://manual/{language}',
      completions: { language: complete },
    }, async uri => ({ contents: [{ uri: String(uri), text: 'manual' }] }));

    expect(prompt.config.completions).toEqual({ language: complete });
    expect(resource.config.completions).toEqual({ language: complete });
    expect(Object.isFrozen(prompt.config.completions)).toBe(true);
    expect(() => defineMcpPrompt({
      name: 'invalid',
      argsSchema: z.object({ language: z.string() }),
      completions: { framework: complete },
    }, async () => ({ messages: [] }))).toThrow(/completion.*framework/i);
  });

  it('freezes copied access scopes instead of retaining a mutable caller array', () => {
    const scopes = ['orders:read'];
    const tool = defineMcpTool({ name: 'lookup', inputSchema: z.object({}), access: { scopes } }, async () => ({ content: [] }));
    scopes.push('orders:admin');

    expect(tool.config.access?.scopes).toEqual(['orders:read']);
    expect(Object.isFrozen(tool.config.access?.scopes)).toBe(true);
  });

  it.each(['bad name', 'a/b', '', 'x'.repeat(129)])('rejects illegal local name %j', (name) => {
    expect(() => defineMcpTool({ name, inputSchema: z.object({}) }, async () => ({ content: [] })))
      .toThrow(HileMcpError);
  });

  it('rejects failover unless the tool is explicitly read-only and idempotent', () => {
    expect(() => defineMcpTool({
      name: 'write',
      inputSchema: z.object({}),
      execution: { retry: 'idempotent-failover' },
    }, async () => ({ content: [] }))).toThrowError(/read-only and idempotent/i);
  });

  it('rejects malformed tool annotations and execution policy at definition time', () => {
    expect(() => defineMcpTool({
      name: 'lookup',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: 'yes' },
    } as any, async () => ({ content: [] }))).toThrowError(/annotations/i);
    expect(() => defineMcpTool({
      name: 'lookup',
      inputSchema: z.object({}),
      execution: { retry: 'sometimes' },
    } as any, async () => ({ content: [] }))).toThrowError(/execution/i);
  });

  it('rejects malformed access and cache metadata records at definition time', () => {
    expect(() => defineMcpTool({
      name: 'lookup', inputSchema: z.object({}), access: 'public',
    } as any, async () => ({ content: [] }))).toThrowError(/access/i);
    expect(() => defineMcpResource({
      kind: 'static', name: 'manual', uri: 'hile://docs/manual', cacheHint: [],
    } as any, async () => ({ contents: [] }))).toThrowError(/cacheHint/i);
  });

  it('uses an explicit static/template resource discriminant', () => {
    const staticResource = defineMcpResource({
      kind: 'static',
      name: 'manual',
      uri: 'hile://docs/manual',
      mimeType: 'text/markdown',
    }, async () => ({ contents: [{ uri: 'hile://docs/manual', text: '# Manual' }] }));
    const templateResource = defineMcpResource({
      kind: 'template',
      name: 'order',
      uriTemplate: 'hile://orders/{id}',
    }, async ({ id }) => ({ contents: [{ uri: `hile://orders/${id}`, text: id }] }));

    expect(staticResource.config.kind).toBe('static');
    expect(templateResource.config.kind).toBe('template');
  });

  it('rejects malformed URI templates before publication', () => {
    expect(() => defineMcpResource({ kind: 'template', name: 'broken', uriTemplate: '{' }, async () => ({ contents: [] })))
      .toThrowError(/RFC 6570/i);
  });

  it('builds an immutable provider and rejects mismatched record keys', () => {
    const tool = defineMcpTool({ name: 'lookup', inputSchema: z.object({}) }, async () => ({ content: [] }));
    const prompt = defineMcpPrompt({ name: 'explain', argsSchema: z.object({ topic: z.string() }) }, async ({ topic }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: topic } }],
    }));

    const provider = defineMcpProvider({ id: 'orders', tools: { lookup: tool }, prompts: { explain: prompt } });
    expect(Object.isFrozen(provider.tools)).toBe(true);
    expect(() => defineMcpProvider({ id: 'orders', tools: { other: tool } })).toThrowError(/record key/i);
    expect(() => defineMcpProvider({ id: 'orders', resources: { lookup: tool } as any })).toThrowError(/defineMcp/i);
    expect(() => defineMcpProvider({ id: 123 as any })).toThrow(HileMcpError);
  });
});
