'use client';

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type AnchorHTMLAttributes,
  type FocusEvent,
  type ForwardedRef,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  resolveRscNavigationUrl,
  shouldHandleRscNavigationClick,
} from './navigation-internals';
import { getRscNavigationRuntime } from './navigation-runtime';
import type { RscClientNavigation, RscNavigationOptions } from './navigation-types';

export type { RscClientNavigation, RscNavigationOptions } from './navigation-types';

function browserLocation(): Location | undefined {
  return typeof window === 'undefined' ? undefined : window.location;
}

function resolveBrowserNavigation(href: string, location: Location): URL {
  const destination = resolveRscNavigationUrl(href, location.href);
  if (!destination) throw new TypeError('RSC navigation href must use HTTP or HTTPS');
  return destination;
}

function installedNavigation(): RscClientNavigation | undefined {
  return getRscNavigationRuntime();
}

const browserNavigation: RscClientNavigation = Object.freeze({
  push(href: string, options?: RscNavigationOptions) {
    const location = browserLocation();
    if (!location) return;
    const destination = resolveBrowserNavigation(href, location);
    const navigation = installedNavigation();
    if (navigation && destination.origin === location.origin) {
      navigation.push(href, options);
      return;
    }
    location.assign(destination.href);
  },
  replace(href: string, options?: RscNavigationOptions) {
    const location = browserLocation();
    if (!location) return;
    const destination = resolveBrowserNavigation(href, location);
    const navigation = installedNavigation();
    if (navigation && destination.origin === location.origin) {
      navigation.replace(href, options);
      return;
    }
    location.replace(destination.href);
  },
  refresh() {
    const navigation = installedNavigation();
    if (navigation) navigation.refresh();
    else browserLocation()?.reload();
  },
  prefetch(href: string) {
    const location = browserLocation();
    if (!location) return;
    const destination = resolveBrowserNavigation(href, location);
    const navigation = installedNavigation();
    if (navigation && destination.origin === location.origin) navigation.prefetch(href);
  },
});

/** Returns a stable facade that uses the Host adapter and safely falls back to browser navigation. */
export function useRscNavigation(): RscClientNavigation {
  return browserNavigation;
}

export interface RscLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  replace?: boolean;
  scroll?: boolean;
  /** Opt-in Host route prefetch triggered by user intent or viewport visibility. */
  prefetch?: false | 'intent' | 'viewport';
}

export function shouldPrefetchRscNavigation(href: string, currentHref: string): boolean {
  const current = resolveRscNavigationUrl(currentHref, currentHref);
  const destination = resolveRscNavigationUrl(href, currentHref);
  return current !== undefined
    && destination !== undefined
    && destination.origin === current.origin;
}

export function prefetchDeclaredRscRoute(
  navigation: RscClientNavigation,
  href: string,
  currentHref: string,
): boolean {
  return shouldPrefetchRscNavigation(href, currentHref)
    && navigation.prefetchRoute?.(href) === true;
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/**
 * Framework-neutral link for independently compiled RSC plugins.
 * Without a Host adapter it remains a normal anchor; external, modified, download,
 * and non-self clicks always retain native browser behavior.
 */
export const RscLink = forwardRef<HTMLAnchorElement, RscLinkProps>(function RscLink({
  href,
  replace = false,
  scroll,
  prefetch = false,
  target,
  download,
  onClick,
  onFocus,
  onPointerEnter,
  ...props
}, ref) {
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const prefetchedHref = useRef<string | undefined>(undefined);
  const setAnchorRef = useCallback((node: HTMLAnchorElement | null) => {
    anchorRef.current = node;
    assignRef(ref, node);
  }, [ref]);
  const triggerPrefetch = useCallback((): boolean => {
    const location = browserLocation();
    const navigation = installedNavigation();
    if (
      !location
      || !navigation
      || prefetchedHref.current === href
      || !shouldPrefetchRscNavigation(href, location.href)
    ) {
      return false;
    }
    if (!prefetchDeclaredRscRoute(navigation, href, location.href)) return false;
    prefetchedHref.current = href;
    return true;
  }, [href]);

  useEffect(() => {
    if (prefetch !== 'viewport' || typeof IntersectionObserver === 'undefined' || !anchorRef.current) {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(({ isIntersecting }) => isIntersecting)) {
        if (triggerPrefetch()) observer.disconnect();
      }
    });
    observer.observe(anchorRef.current);
    return () => observer.disconnect();
  }, [prefetch, triggerPrefetch]);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      typeof window === 'undefined'
      || !shouldHandleRscNavigationClick(event, { href, target, download }, window.location.href)
    ) {
      return;
    }

    const navigation = installedNavigation();
    if (!navigation && !replace) return;
    event.preventDefault();
    const options = scroll === undefined ? undefined : { scroll };
    if (replace) browserNavigation.replace(href, options);
    else navigation!.push(href, options);
  }

  function handleFocus(event: FocusEvent<HTMLAnchorElement>) {
    onFocus?.(event);
    if (prefetch === 'intent' && !event.defaultPrevented) triggerPrefetch();
  }

  function handlePointerEnter(event: PointerEvent<HTMLAnchorElement>) {
    onPointerEnter?.(event);
    if (prefetch === 'intent' && !event.defaultPrevented) triggerPrefetch();
  }

  return React.createElement('a', {
    ...props,
    ref: setAnchorRef,
    href,
    target,
    download,
    onClick: handleClick,
    onFocus: handleFocus,
    onPointerEnter: handlePointerEnter,
  });
});
