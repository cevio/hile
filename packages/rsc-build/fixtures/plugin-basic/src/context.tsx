import { createContext, useContext } from 'react';

export const FixtureContext = createContext('missing-client-context');

export function useFixtureContext(): string {
  return useContext(FixtureContext);
}
