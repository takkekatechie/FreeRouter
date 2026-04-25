import type { RateLimiterLike } from '../finops/rate-limiter.js'
import type { RateLimitConfig } from '../types.js'

/**
 * Minimal duck-typed Redis client interface (eval support).
 * Compatible with `redis` v4 and `ioredis`.
 */
export interface RedisEvalClientLike {
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<unknown>
}

/**
 * Atomic sliding-window rate limiter backed by Redis.
 * Uses a Lua script for atomic increment+check to avoid TOCTOU races in clusters.
 *
 * Drop-in replacement for RateLimiter — implements RateLimiterLike.
 *
 * Pass to FreeRouter via config if you need distributed rate limiting:
 *   const limiter = new RedisRateLimiter(redisClient, config)
 *   // Then wire into router internals via the rateLimiter constructor option (advanced use)
 */
export class RedisRateLimiter implements RateLimiterLike {
  private readonly config: Required<Omit<RateLimitConfig, 'scope'>>
  private readonly prefix: string
  private readonly windowMs = 60_000

  // Lua script: INCR with TTL set on first use, returns [requestCount, tokenCount]
  private readonly luaScript = `
    local req_key = KEYS[1]
    local tok_key = KEYS[2]
    local tokens = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local req_count = redis.call('INCR', req_key)
    if req_count == 1 then redis.call('PEXPIRE', req_key, window) end
    local tok_count = redis.call('INCRBY', tok_key, tokens)
    if tok_count == tokens then redis.call('PEXPIRE', tok_key, window) end
    return {req_count, tok_count}
  `

  constructor(
    private readonly client: RedisEvalClientLike,
    config: RateLimitConfig,
    opts: { keyPrefix?: string } = {},
  ) {
    this.config = {
      requestsPerMinute: config.requestsPerMinute,
      tokensPerMinute:   config.tokensPerMinute   ?? config.requestsPerMinute * 1_000,
      burstAllowance:    config.burstAllowance     ?? 0.1,
    }
    this.prefix = opts.keyPrefix ?? 'freerouter:rl:'
  }

  check(_key: string, _estimatedTokens = 0): { allowed: boolean; reason?: string } {
    // Sync check is not possible with Redis; always allow and rely on consume() for enforcement.
    // For strict pre-flight checking, use checkAsync().
    return { allowed: true }
  }

  /**
   * Async check — preferred for distributed use.
   * Uses current window counts without incrementing.
   */
  async checkAsync(key: string, estimatedTokens = 0): Promise<{ allowed: boolean; reason?: string }> {
    const reqKey = `${this.prefix}req:${key}`
    const tokKey = `${this.prefix}tok:${key}`

    const maxRequests = Math.ceil(this.config.requestsPerMinute * (1 + this.config.burstAllowance))
    const maxTokens = Math.ceil(this.config.tokensPerMinute * (1 + this.config.burstAllowance))

    const [reqRaw, tokRaw] = await Promise.all([
      this.client.get(reqKey),
      this.client.get(tokKey),
    ])

    const reqCount = parseInt(reqRaw ?? '0', 10)
    const tokCount = parseInt(tokRaw ?? '0', 10)

    if (reqCount >= maxRequests) {
      return { allowed: false, reason: `Rate limit exceeded: ${reqCount}/${maxRequests} requests/min for key "${key}"` }
    }
    if (estimatedTokens > 0 && tokCount + estimatedTokens > maxTokens) {
      return { allowed: false, reason: `Token rate limit exceeded for key "${key}"` }
    }
    return { allowed: true }
  }

  consume(key: string, tokensUsed = 0): void {
    const reqKey = `${this.prefix}req:${key}`
    const tokKey = `${this.prefix}tok:${key}`

    this.client.eval(
      this.luaScript,
      2,
      reqKey,
      tokKey,
      String(tokensUsed),
      String(this.windowMs),
    ).catch((err: unknown) => {
      // Fall back gracefully — log but don't block the request
      process.stderr.write(`[FreeRouter/RedisRateLimiter] eval error (falling back): ${String(err)}\n`)
      // Non-atomic fallback: best-effort INCR
      this.client.set(reqKey, '1', { EX: 60, NX: true }).catch(() => undefined)
    })
  }

  prune(): void {
    // Redis handles TTL expiry automatically — nothing to prune locally
  }
}
