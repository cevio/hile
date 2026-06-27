export const REPLACE_CACHE_TAGS = `
-- REPLACE_CACHE_TAGS
local cacheKey = ARGV[1]
local tagPrefix = ARGV[2]
local next = {}

for i = 3, #ARGV do
  next[ARGV[i]] = true
end

local previous = redis.call('SMEMBERS', KEYS[1])
for _, tag in ipairs(previous) do
  if not next[tag] then
    redis.call('SREM', tagPrefix .. tag, cacheKey)
  end
end

redis.call('DEL', KEYS[1])
for i = 3, #ARGV do
  redis.call('SADD', tagPrefix .. ARGV[i], cacheKey)
  redis.call('SADD', KEYS[1], ARGV[i])
end

return #ARGV - 2
`;

export const FORGET_CACHE_TAGS = `
-- FORGET_CACHE_TAGS
local cacheKey = ARGV[1]
local tagPrefix = ARGV[2]
local tags = redis.call('SMEMBERS', KEYS[1])

for _, tag in ipairs(tags) do
  redis.call('SREM', tagPrefix .. tag, cacheKey)
end
redis.call('DEL', KEYS[1])

return #tags
`;

export const REMOVE_CACHE_TAG = `
-- REMOVE_CACHE_TAG
local tagPrefix = ARGV[1]
local indexPrefix = ARGV[2]
local cacheKeys = redis.call('SMEMBERS', KEYS[1])
local removed = 0

for _, cacheKey in ipairs(cacheKeys) do
  local indexKey = indexPrefix .. cacheKey
  local tags = redis.call('SMEMBERS', indexKey)

  for _, tag in ipairs(tags) do
    redis.call('SREM', tagPrefix .. tag, cacheKey)
  end

  redis.call('DEL', indexKey)
  removed = removed + redis.call('DEL', cacheKey)
end

redis.call('DEL', KEYS[1])

return removed
`;
