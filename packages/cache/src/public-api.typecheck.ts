import { decodeCacheValue, type CacheReadResult } from './index';

type Equal<A, B> = (
  <T>() => T extends A ? 1 : 2
) extends (
  <T>() => T extends B ? 1 : 2
) ? true : false;

type Expect<T extends true> = T;

type UserProfile = {
  id: string;
  name: string;
};

const decoded = decodeCacheValue<UserProfile>('{"id":"1","name":"Ada"}');
type _DecodeWithoutOptions = Expect<Equal<typeof decoded, CacheReadResult<UserProfile>>>;

const decodedWithOptions = decodeCacheValue<UserProfile, 'user:{id:string}'>(
  '{"id":"1","name":"Ada"}',
  { stale: { ttl: 60 } },
);
type _DecodeWithOptions = Expect<Equal<typeof decodedWithOptions, CacheReadResult<UserProfile>>>;
