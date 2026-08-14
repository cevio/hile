export const MAX_TIMER_MS = 2_147_483_647;

export function assertTimerMs(value: number, name: string, minimum = 1): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${MAX_TIMER_MS}`);
  }
}
