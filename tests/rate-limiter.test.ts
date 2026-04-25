import { describe, it, expect } from 'vitest'
import { RateLimiter } from '../src/finops/rate-limiter.js'

describe('RateLimiter', () => {
  it('allows requests within limit', () => {
    const rl = new RateLimiter({ requestsPerMinute: 10 })
    const result = rl.check('user1')
    expect(result.allowed).toBe(true)
  })

  it('blocks after limit is reached', () => {
    const rl = new RateLimiter({ requestsPerMinute: 2, burstAllowance: 0 })
    for (let i = 0; i < 2; i++) rl.consume('user1')
    const result = rl.check('user1')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Rate limit exceeded')
  })

  it('allows burst within tolerance', () => {
    const rl = new RateLimiter({ requestsPerMinute: 10, burstAllowance: 0.5 })
    // 15 requests allowed (10 * 1.5 = 15)
    for (let i = 0; i < 14; i++) rl.consume('user1')
    expect(rl.check('user1').allowed).toBe(true)
    rl.consume('user1')
    expect(rl.check('user1').allowed).toBe(false)
  })

  it('tracks separate buckets per key', () => {
    const rl = new RateLimiter({ requestsPerMinute: 1, burstAllowance: 0 })
    rl.consume('user1')
    expect(rl.check('user1').allowed).toBe(false)
    expect(rl.check('user2').allowed).toBe(true)
  })

  it('blocks when token limit exceeded', () => {
    const rl = new RateLimiter({ requestsPerMinute: 100, tokensPerMinute: 1000, burstAllowance: 0 })
    rl.consume('user1', 999)
    expect(rl.check('user1', 2).allowed).toBe(false)
    expect(rl.check('user1', 2).reason).toContain('Token rate limit')
  })
})
