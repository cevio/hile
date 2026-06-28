import Redis from 'ioredis';
import { RedisStreamQueue, defineQueue } from './index';

const redis = new Redis();
const queue = new RedisStreamQueue(redis);
const jobs = defineQueue<{ id: string }>('jobs');

void queue.add(jobs, { id: '1' });
