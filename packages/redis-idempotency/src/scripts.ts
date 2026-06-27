export const ACQUIRE_OR_READ = `
-- ACQUIRE_OR_READ
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
  return { 'ACQUIRED' }
end

local value = cjson.decode(raw)
if value.fingerprint ~= ARGV[2] then
  return { 'MISMATCH' }
end
if value.state == 'DONE' then
  return { 'CACHED', raw }
end
return { 'IN_FLIGHT' }
`;

export const COMMIT_IF_OWNER = `
-- COMMIT_IF_OWNER
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.state == 'IN_FLIGHT' and value.token == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`;

export const RELEASE_IF_OWNER = `
-- RELEASE_IF_OWNER
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.state == 'IN_FLIGHT' and value.token == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
