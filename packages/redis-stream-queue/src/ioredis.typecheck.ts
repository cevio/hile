import Redis from 'ioredis';
import { createExecutionContext } from '@hile/context';
import { RedisStreamQueue, defineQueue } from './index';

const redis = new Redis();
const queue = new RedisStreamQueue(redis);
const jobs = defineQueue<{ id: string }>('jobs');

void queue.add(jobs, { id: '1' }, { context: createExecutionContext({ test: true }) });
