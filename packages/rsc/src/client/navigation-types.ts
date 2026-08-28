export interface RscNavigationOptions {
  scroll?: boolean;
}

/** Host-owned browser navigation port implemented by a framework adapter. */
export interface RscClientNavigation {
  push(href: string, options?: RscNavigationOptions): void;
  replace(href: string, options?: RscNavigationOptions): void;
  refresh(): void;
  prefetch(href: string): void;
}
