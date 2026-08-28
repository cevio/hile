export interface RscNavigationClick {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface RscNavigationAnchor {
  href: string;
  target?: string;
  download?: string | boolean;
}

export function resolveRscNavigationUrl(href: string, currentHref: string): URL | undefined {
  try {
    const destination = new URL(href, currentHref);
    return destination.protocol === 'http:' || destination.protocol === 'https:'
      ? destination
      : undefined;
  } catch {
    return undefined;
  }
}

export function shouldHandleRscNavigationClick(
  event: RscNavigationClick,
  anchor: RscNavigationAnchor,
  currentHref: string,
): boolean {
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
    || (
      anchor.target !== undefined
      && anchor.target !== ''
      && anchor.target.toLowerCase() !== '_self'
    )
    || (anchor.download !== undefined && anchor.download !== false)
  ) {
    return false;
  }

  const current = resolveRscNavigationUrl(currentHref, currentHref);
  const destination = resolveRscNavigationUrl(anchor.href, currentHref);
  return current !== undefined
    && destination !== undefined
    && destination.origin === current.origin;
}
