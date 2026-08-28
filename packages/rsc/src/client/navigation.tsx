'use client';

import React, {
  forwardRef,
  type AnchorHTMLAttributes,
  type MouseEvent,
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
  target,
  download,
  onClick,
  ...props
}, ref) {
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

  return React.createElement('a', {
    ...props,
    ref,
    href,
    target,
    download,
    onClick: handleClick,
  });
});
