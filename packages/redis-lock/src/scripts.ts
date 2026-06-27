export const TRY_ACQUIRE_LOCK = `
-- TRY_ACQUIRE_LOCK
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  if ARGV[3] == '1' then
    local fencing = redis.call('INCR', KEYS[2])
    return { 'ACQUIRED', tostring(fencing) }
  end
  return { 'ACQUIRED' }
end
return { 'LOCKED' }
`;

export const RELEASE_LOCK_IF_OWNER = `
-- RELEASE_LOCK_IF_OWNER
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const RENEW_LOCK_IF_OWNER = `
-- RENEW_LOCK_IF_OWNER
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

export const ASSERT_LOCK_OWNER = `
-- ASSERT_LOCK_OWNER
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return 1
end
return 0
`;
