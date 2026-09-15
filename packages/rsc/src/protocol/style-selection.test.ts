import { describe, expect, it } from 'vitest';
import { selectRscClientStyles } from './style-selection';

const styles = [
  { path: 'styles/global.css', scope: 'plugin' as const },
  { path: 'client/first.css', scope: 'client' as const },
  { path: 'client/second.css', scope: 'client' as const },
];

describe('selectRscClientStyles', () => {
  it('preserves all-style loading for legacy clients without reachability metadata', () => {
    expect(selectRscClientStyles(styles, [{}])).toEqual(styles);
  });

  it('selects plugin-wide and referenced client styles only', () => {
    expect(selectRscClientStyles(styles, [{ styles: ['client/first.css'] }]))
      .toEqual([styles[0], styles[1]]);
  });

  it('fails closed when client metadata references an unknown style', () => {
    expect(selectRscClientStyles(styles, [{ styles: ['client/missing.css'] }]))
      .toBeUndefined();
  });
});
