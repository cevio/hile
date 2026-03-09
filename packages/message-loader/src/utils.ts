export function toRouterPath(path: string) {
  return path.replace(/\[([^\]]+)\]/g, ':$1');
}