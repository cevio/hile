export const COMMIT_DONE_IF_LOCK_OWNER = `
-- COMMIT_DONE_IF_LOCK_OWNER
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return 0
end

local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.state == 'IN_FLIGHT' and value.token == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0
`;

export const CLEAR_IN_FLIGHT_IF_LOCK_OWNER = `
-- CLEAR_IN_FLIGHT_IF_LOCK_OWNER
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return 0
end

local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.state == 'IN_FLIGHT' and value.token == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
