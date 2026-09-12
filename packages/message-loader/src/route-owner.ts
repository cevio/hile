import { addRoute, createRouter } from 'rou3';
import type { RouterContext } from 'rou3';
import type { MessageRegisterProps } from './message.js';

type Segment = { kind: 'static'; value: string } | { kind: 'param' | 'wildcard' };

interface RouteVariant {
  segments: Segment[];
  priority: string;
}

export interface RouteOwner {
  path: string;
  metadata: MessageRegisterProps;
  variants: RouteVariant[];
}

export class MessageRouteConflictError extends Error {
  public readonly status = 'HILE_MESSAGE_ROUTE_CONFLICT';

  constructor() {
    super('Message routes conflict');
  }
}

/** Normalize URL separators and dot segments without stripping rou3's regex syntax. */
export function normalizeMessagePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return '/' + segments.join('/');
}

/** Use rou3's own parsed tree so optional groups and catch-all aliases stay aligned. */
export function createRouteOwner(path: string, metadata: MessageRegisterProps): RouteOwner {
  const router = createRouter<MessageRegisterProps>();
  addRoute(router, 'GET', path, metadata);
  const variants: RouteVariant[] = [];

  const visit = (node: RouterContext<MessageRegisterProps>['root'], segments: Segment[]) => {
    if (node.methods?.GET?.length) {
      const counts = { static: 0, param: 0, wildcard: 0 };
      for (const segment of segments) counts[segment.kind]++;
      variants.push({
        segments,
        priority: `${counts.static}:${counts.param}:${counts.wildcard}`,
      });
    }
    for (const [value, child] of Object.entries(node.static ?? {})) {
      visit(child, [...segments, { kind: 'static', value }]);
    }
    if (node.param) visit(node.param, [...segments, { kind: 'param' }]);
    if (node.wildcard) visit(node.wildcard, [...segments, { kind: 'wildcard' }]);
  };
  visit(router.root, []);
  return { path, metadata, variants };
}

/**
 * Reject equal-specificity overlaps conservatively: regex parameters are treated
 * as unrestricted parameters. Disjoint regexes with the same shape also conflict;
 * static > parameter > catch-all overlaps remain supported by rou3.
 */
export function assertRouteAvailable(owner: RouteOwner, existing: Iterable<RouteOwner>): void {
  for (const other of existing) {
    if (owner.path === other.path) throw new MessageRouteConflictError();
    for (const left of owner.variants) {
      for (const right of other.variants) {
        if (left.priority !== right.priority) continue;
        let overlaps = true;
        for (let index = 0; index < left.segments.length; index++) {
          const a = left.segments[index];
          const b = right.segments[index];
          if (a.kind === 'wildcard' || b.kind === 'wildcard') break;
          if (a.kind === 'static' && b.kind === 'static' && a.value !== b.value) {
            overlaps = false;
            break;
          }
        }
        if (overlaps) throw new MessageRouteConflictError();
      }
    }
  }
}

export function buildRouter(owners: Iterable<RouteOwner>): RouterContext<MessageRegisterProps> {
  const router = createRouter<MessageRegisterProps>();
  for (const owner of owners) addRoute(router, 'GET', owner.path, owner.metadata);
  return router;
}
