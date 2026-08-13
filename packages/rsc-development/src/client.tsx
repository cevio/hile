'use client';

import { useEffect } from 'react';

export interface RscDevelopmentReloadProps {
  endpoint?: string;
  pluginIds?: readonly string[];
}

/** Reloads only after the Host announces that a complete plugin revision is active. */
export function RscDevelopmentReload({
  endpoint = '/_hile/rsc/development',
  pluginIds,
}: RscDevelopmentReloadProps) {
  useEffect(() => {
    const allowed = pluginIds ? new Set(pluginIds) : undefined;
    const source = new EventSource(endpoint);
    const reload = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as { pluginId?: unknown };
        if (typeof event.pluginId !== 'string' || (allowed && !allowed.has(event.pluginId))) return;
        window.location.reload();
      } catch {
        // Ignore malformed development messages; reconnect remains owned by EventSource.
      }
    };
    source.addEventListener('revision', reload as EventListener);
    return () => {
      source.removeEventListener('revision', reload as EventListener);
      source.close();
    };
  }, [endpoint, pluginIds]);
  return null;
}
