import {
  createRscDiscoveryTopic,
  HILE_RSC_DISCOVERY_TOPIC_PREFIX,
  validateRscDiscoveryAnnouncement,
  type RscDiscoveryAnnouncement,
} from '@hile/rsc-discovery';

export interface HileRscRegistryReader {
  listRegistryTopics(prefix?: string): Promise<Array<{ topic: string; hasData: boolean }>>;
  getRegistryTopic<T = unknown>(topic: string): Promise<{ hasData: boolean; payload: T } | undefined>;
}

export interface HileRscDiscoverySnapshot {
  announcements: RscDiscoveryAnnouncement[];
  rejected: Array<{ topic: string; error: unknown }>;
}

export async function readHileRscDiscoverySnapshot(
  application: HileRscRegistryReader,
): Promise<HileRscDiscoverySnapshot> {
  const topics = await application.listRegistryTopics(HILE_RSC_DISCOVERY_TOPIC_PREFIX);
  const announcements: RscDiscoveryAnnouncement[] = [];
  const rejected: Array<{ topic: string; error: unknown }> = [];
  for (const summary of [...topics].sort((a, b) => a.topic.localeCompare(b.topic))) {
    if (!summary.hasData) continue;
    try {
      const snapshot = await application.getRegistryTopic(summary.topic);
      if (!snapshot?.hasData) continue;
      const announcement = validateRscDiscoveryAnnouncement(snapshot.payload);
      if (createRscDiscoveryTopic(announcement.instanceId) !== summary.topic) {
        throw new TypeError('RSC discovery topic does not match instanceId');
      }
      announcements.push(announcement);
    } catch (error) {
      rejected.push({ topic: summary.topic, error });
    }
  }
  return { announcements, rejected };
}
