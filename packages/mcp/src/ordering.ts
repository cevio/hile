export function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
