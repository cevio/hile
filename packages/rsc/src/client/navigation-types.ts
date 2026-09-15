export interface RscNavigationOptions {
  scroll?: boolean;
}

/** Host-owned browser navigation port implemented by a framework adapter. */
export interface RscClientNavigation {
  push(href: string, options?: RscNavigationOptions): void;
  replace(href: string, options?: RscNavigationOptions): void;
  refresh(): void;
  /** Explicit imperative prefetch operation preserved for existing plugin code. */
  prefetch(href: string): void;
  /** Host-policy-gated automatic route prefetch used by declarative links. */
  prefetchRoute?(href: string): boolean;
}
