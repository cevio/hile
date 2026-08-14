import {
  createRscDiscoveryTopic,
  HILE_RSC_DISCOVERY_TOPIC_PREFIX,
  validateRscDiscoveryAnnouncement,
  type RscDiscoveryAnnouncement,
} from '@hile/rsc-discovery';

export interface HileRscRegistryReader {
  listRegistryTopics(prefix?: string, options?: { signal?: AbortSignal }): Promise<Array<{ topic: string; hasData: boolean }>>;
  getRegistryTopic<T = unknown>(topic: string, options?: { signal?: AbortSignal }): Promise<{ hasData: boolean; payload: T } | undefined>;
}

export interface HileRscDiscoverySnapshot {
  announcements: RscDiscoveryAnnouncement[];
  rejected: Array<{ topic: string; error: unknown }>;
}

export interface ReadHileRscDiscoverySnapshotOptions {
  /** Maximum simultaneous Registry reads. Defaults to 16 and is capped at 64. */
  concurrency?: number;
  signal?: AbortSignal;
}

export async function readHileRscDiscoverySnapshot(
  application: HileRscRegistryReader,
  options: ReadHileRscDiscoverySnapshotOptions = {},
): Promise<HileRscDiscoverySnapshot> {
  const concurrency = options.concurrency ?? 16;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new TypeError('RSC discovery reader concurrency must be an integer between 1 and 64');
  }
  options.signal?.throwIfAborted();
  const topics = await application.listRegistryTopics(
    HILE_RSC_DISCOVERY_TOPIC_PREFIX,
    { signal: options.signal },
  );
  const announcements: RscDiscoveryAnnouncement[] = [];
  const rejected: Array<{ topic: string; error: unknown }> = [];
  const summaries = [...topics]
    .filter(({ hasData }) => hasData)
    .sort((a, b) => a.topic.localeCompare(b.topic));
  const results: Array<RscDiscoveryAnnouncement | { error: unknown } | undefined>
    = new Array(summaries.length);
  let nextIndex = 0;
  const readNext = async () => {
    while (nextIndex < summaries.length) {
      options.signal?.throwIfAborted();
      const index = nextIndex++;
      const summary = summaries[index];
      try {
        const snapshot = await application.getRegistryTopic(summary.topic, { signal: options.signal });
        if (!snapshot?.hasData) continue;
        const announcement = validateRscDiscoveryAnnouncement(snapshot.payload);
        if (createRscDiscoveryTopic(announcement.instanceId) !== summary.topic) {
          throw new TypeError('RSC discovery topic does not match instanceId');
        }
        results[index] = announcement;
      } catch (error) {
        results[index] = { error };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, summaries.length) },
    () => readNext(),
  ));
  options.signal?.throwIfAborted();
  for (const [index, result] of results.entries()) {
    if (!result) continue;
    if ('error' in result) rejected.push({ topic: summaries[index].topic, error: result.error });
    else announcements.push(result);
  }
  return { announcements, rejected };
}
