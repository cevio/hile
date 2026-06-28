export const FIXED_WINDOW_RATE_LIMIT = `
-- FIXED_WINDOW_RATE_LIMIT
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local dry_run = ARGV[4]

local raw = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
local current = tonumber(raw or '0')

if ttl < 0 then
  current = 0
  ttl = window
  if dry_run == '0' then
    redis.call('DEL', KEYS[1])
  end
end

local next_count = current + 1
local observed_count = next_count

if dry_run == '0' then
  if current == 0 then
    redis.call('SET', KEYS[1], '1', 'PX', window)
    observed_count = 1
    ttl = window
  else
    observed_count = redis.call('INCR', KEYS[1])
    ttl = redis.call('PTTL', KEYS[1])
    if ttl < 0 then
      redis.call('PEXPIRE', KEYS[1], window)
      ttl = window
    end
  end
end

local allowed = observed_count <= limit
local remaining = limit - observed_count
if remaining < 0 then remaining = 0 end
local retry_after = 0
if not allowed then retry_after = ttl end

return {
  allowed and 1 or 0,
  remaining,
  now + ttl,
  retry_after
}
`;

export const SLIDING_WINDOW_RATE_LIMIT = `
-- SLIDING_WINDOW_RATE_LIMIT
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local dry_run = ARGV[4]
local member = ARGV[5]
local cutoff = now - window

local count
if dry_run == '1' then
  count = redis.call('ZCOUNT', KEYS[1], '(' .. cutoff, '+inf')
else
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)
  count = redis.call('ZCARD', KEYS[1])
end

local allowed = count < limit
local observed_count = count

if allowed then
  observed_count = count + 1
  if dry_run == '0' then
    redis.call('ZADD', KEYS[1], now, member)
    redis.call('PEXPIRE', KEYS[1], window)
  end
end

local earliest
if dry_run == '1' then
  local existing = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. cutoff, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  if existing[2] then
    earliest = tonumber(existing[2])
    if allowed and now < earliest then earliest = now end
  elseif allowed then
    earliest = now
  else
    earliest = now
  end
else
  local existing = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if existing[2] then
    earliest = tonumber(existing[2])
  else
    earliest = now
  end
end

local reset_at = earliest + window
local retry_after = 0
if not allowed then retry_after = reset_at - now end
if retry_after < 0 then retry_after = 0 end

local remaining = limit - observed_count
if remaining < 0 then remaining = 0 end

return {
  allowed and 1 or 0,
  remaining,
  reset_at,
  retry_after
}
`;

export const TOKEN_BUCKET_RATE_LIMIT = `
-- TOKEN_BUCKET_RATE_LIMIT
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local dry_run = ARGV[4]

local raw_tokens = redis.call('HGET', KEYS[1], 'tokens')
local raw_updated_at = redis.call('HGET', KEYS[1], 'updatedAt')

local previous_tokens = tonumber(raw_tokens or limit)
local updated_at = tonumber(raw_updated_at or now)
local effective_now = now
if effective_now < updated_at then effective_now = updated_at end
local elapsed = effective_now - updated_at

local refill = elapsed * limit / window
local available = previous_tokens + refill
if available > limit then available = limit end

local allowed = available >= 1
local next_tokens = available
if allowed then next_tokens = available - 1 end

local next_token_at = effective_now + math.ceil((1 - available) * window / limit)
local full_at = effective_now + math.ceil((limit - next_tokens) * window / limit)
local reset_at = full_at
if not allowed then reset_at = next_token_at end

local retry_after = 0
if not allowed then
  retry_after = reset_at - now
end
if retry_after < 0 then retry_after = 0 end

if dry_run == '0' then
  local expire_after = full_at - now
  if expire_after < 1 then expire_after = 1 end
  redis.call('HSET', KEYS[1], 'tokens', tostring(next_tokens), 'updatedAt', tostring(effective_now))
  redis.call('PEXPIRE', KEYS[1], expire_after)
end

return {
  allowed and 1 or 0,
  math.floor(next_tokens),
  reset_at,
  retry_after
}
`;
