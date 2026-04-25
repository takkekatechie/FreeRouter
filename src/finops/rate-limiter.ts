import type { RateLimitConfig } from '../types.js'

interface Bucket {
  tokens: number
  lastRefillMs: number
  requestCount: number
  windowStartMs: number
}

/** Common interface for local and distributed rate limiters */
export interface RateLimiterLike {
  check(key: string, estimatedTokens?: number): { allowed: boolean; reason?: string }
  consume(key: string, tokensUsed?: number): void
  prune(): void
}

/**
 * Token-bucket rate limiter.
 * Supports per-key buckets (userId, teamId, etc.) with configurable burst.
 */
export class RateLimiter implements RateLimiterLike {
  private readonly buckets = new Map<string, Bucket>()
  private readonly config: Required<Omit<RateLimitConfig, 'scope'>>

  constructor(config: RateLimitConfig) {
    this.config = {
      requestsPerMinute: config.requestsPerMinute,
      tokensPerMinute:   config.tokensPerMinute   ?? config.requestsPerMinute * 1_000,
      burstAllowance:    config.burstAllowance     ?? 0.1,
    }
  }

  /**
   * Returns true if the request is allowed, false if rate-limited.
   * @param key  Typically userId or teamId
   * @param estimatedTokens  Rough token count for the request (optional)
   */
  check(key: string, estimatedTokens = 0): { allowed: boolean; reason?: string } {
    const now = Date.now()
    const windowMs = 60_000
    const bucket = this.getBucket(key, now, windowMs)

    const maxRequests = Math.ceil(
      this.config.requestsPerMinute * (1 + this.config.burstAllowance),
    )
    const maxTokens = Math.ceil(
      this.config.tokensPerMinute * (1 + this.config.burstAllowance),
    )

    if (bucket.requestCount >= maxRequests) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${bucket.requestCount}/${maxRequests} requests/min for key "${key}"`,
      }
    }

    if (estimatedTokens > 0 && bucket.tokens + estimatedTokens > maxTokens) {
      return {
        allowed: false,
        reason: `Token rate limit exceeded: ${(bucket.tokens + estimatedTokens)}/${maxTokens} tokens/min for key "${key}"`,
      }
    }

    return { allowed: true }
  }

  /** Consume a slot (call after check returns allowed=true). */
  consume(key: string, tokensUsed = 0): void {
    const now = Date.now()
    const bucket = this.getBucket(key, now, 60_000)
    bucket.requestCount++
    bucket.tokens += tokensUsed
  }

  private getBucket(key: string, now: number, windowMs: number): Bucket {
    const existing = this.buckets.get(key)
    if (existing === undefined || now - existing.windowStartMs >= windowMs) {
      const fresh: Bucket = { tokens: 0, lastRefillMs: now, requestCount: 0, windowStartMs: now }
      this.buckets.set(key, fresh)
      return fresh
    }
    return existing
  }

  /** Remove stale buckets to prevent unbounded memory growth. */
  prune(): void {
    const cutoff = Date.now() - 120_000 // 2 minutes
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStartMs < cutoff) this.buckets.delete(key)
    }
  }
}
