import { networkInterfaces } from 'node:os';

function isIPv4(family: string | number): boolean {
  return family === 'IPv4' || family === 4;
}

/**
 * 获取本机第一个非回环、非内部的 IPv4 地址；若无则返回 `undefined`。
 */
export function getLocalIPv4(): string | undefined {
  const ifaces = networkInterfaces();
  if (!ifaces) {
    return undefined;
  }

  for (const addrs of Object.values(ifaces)) {
    if (!addrs) {
      continue;
    }
    for (const addr of addrs) {
      if (isIPv4(addr.family) && !addr.internal) {
        return addr.address;
      }
    }
  }

  return undefined;
}
