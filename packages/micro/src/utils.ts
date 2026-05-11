import { internalIpV4Sync } from 'internal-ip';

/**
 * 本机用于「宣告」给其他节点的 IPv4（与 {@link internalIpV4Sync} 行为一致：多网卡无法唯一确定时可能为 `undefined`）。
 */
export function getLocalIPv4(): string | undefined {
  return internalIpV4Sync();
}
