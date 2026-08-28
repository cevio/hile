import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRscNavigation } from './navigation';
import {
  getRscNavigationRuntime,
  installRscNavigationRuntime,
} from './navigation-runtime';
import {
  resolveRscNavigationUrl,
  shouldHandleRscNavigationClick,
} from './navigation-internals';

const primaryClick = {
  button: 0,
  defaultPrevented: false,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RSC client navigation link policy', () => {
  it.each([
    '/blog/posts/hello',
    '?page=2',
    '#comments',
    'https://example.test/account',
  ])('handles same-origin navigation through the Host adapter: %s', (href) => {
    expect(shouldHandleRscNavigationClick(
      primaryClick,
      { href },
      'https://example.test/blog',
    )).toBe(true);
  });

  it('accepts explicit self targets and disabled download attributes', () => {
    expect(shouldHandleRscNavigationClick(
      primaryClick,
      { href: '/blog', target: '_SELF', download: false },
      'https://example.test/',
    )).toBe(true);
  });

  it.each([
    ['external origin', { href: 'https://other.test/blog' }, primaryClick],
    ['mailto URL', { href: 'mailto:hello@example.test' }, primaryClick],
    ['malformed URL', { href: 'http://[' }, primaryClick],
    ['new browsing context', { href: '/blog', target: '_blank' }, primaryClick],
    ['download', { href: '/export', download: true }, primaryClick],
    ['modified click', { href: '/blog' }, { ...primaryClick, ctrlKey: true }],
    ['non-primary click', { href: '/blog' }, { ...primaryClick, button: 1 }],
    ['consumer cancellation', { href: '/blog' }, { ...primaryClick, defaultPrevented: true }],
  ])('leaves %s to native browser behavior', (_label, anchor, event) => {
    expect(shouldHandleRscNavigationClick(
      event,
      anchor,
      'https://example.test/',
    )).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'mailto:hello@example.test',
    'http://[',
  ])('does not resolve unsupported or malformed destinations: %s', (href) => {
    expect(resolveRscNavigationUrl(href, 'https://example.test/')).toBeUndefined();
  });
});

describe('RSC Host navigation runtime ownership', () => {
  function adapter() {
    return {
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    };
  }

  it('routes through the installed Host adapter and cleans up only its own installation', () => {
    const first = adapter();
    const second = adapter();
    const closeFirst = installRscNavigationRuntime(first);
    const closeSecond = installRscNavigationRuntime(second);

    useRscNavigation().refresh();
    expect(second.refresh).toHaveBeenCalledOnce();
    expect(first.refresh).not.toHaveBeenCalled();

    closeFirst();
    useRscNavigation().refresh();
    expect(second.refresh).toHaveBeenCalledTimes(2);

    closeSecond();
    expect(getRscNavigationRuntime()).toBeUndefined();
  });

  it('restores the previous Host adapter when the latest installation closes first', () => {
    const first = adapter();
    const second = adapter();
    const closeFirst = installRscNavigationRuntime(first);
    const closeSecond = installRscNavigationRuntime(second);

    closeSecond();
    useRscNavigation().refresh();
    expect(first.refresh).toHaveBeenCalledOnce();
    expect(second.refresh).not.toHaveBeenCalled();

    closeFirst();
    expect(getRscNavigationRuntime()).toBeUndefined();
  });

  it('rejects incomplete Host adapters before replacing the active runtime', () => {
    const active = adapter();
    const close = installRscNavigationRuntime(active);
    expect(() => installRscNavigationRuntime({
      ...adapter(),
      refresh: undefined,
    } as never)).toThrow('refresh must be a function');
    expect(getRscNavigationRuntime()).toBe(active);
    close();
  });

  it('rejects unsafe imperative destinations without invoking the browser location', () => {
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: {
        href: 'https://example.test/current',
        origin: 'https://example.test',
        assign,
      },
    });

    expect(() => useRscNavigation().push('javascript:alert(1)'))
      .toThrow('must use HTTP or HTTPS');
    expect(assign).not.toHaveBeenCalled();
  });
});
