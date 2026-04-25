import { describe, it, expect, vi } from 'vitest'
import { RedisKeyStore } from '../src/adapters/redis-key-store.js'
import { RedisRateLimiter } from '../src/adapters/redis-rate-limiter.js'
import type { StoredKey } from '../src/security/key-manager.js'

// ─── Mock Redis client ────────────────────────────────────────────────────────

function makeMockRedisClient() {
  const store = new Map<string, string>()
  return {
    store,
    async set(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async del(key: string | string[]) {
      if (Array.isArray(key)) key.forEach(k => store.delete(k))
      else store.delete(key)
    },
    async eval(_script: string, _numkeys: number, ...args: string[]) {
      // Minimal eval simulation: increment request counter
      const reqKey = args[0] ?? ''
      const current = parseInt(store.get(reqKey) ?? '0', 10)
      store.set(reqKey, String(current + 1))
      return [current + 1, 0]
    },
  }
}

function makeFakeBlob(): StoredKey {
  return {
    ciphertext: Buffer.from('encrypted', 'utf8'),
    iv: Buffer.from('iv123456789012', 'utf8').slice(0, 12),
    tag: Buffer.from('tag1234567890123', 'utf8').slice(0, 16),
    createdAt: Date.now(),
  }
}

// ─── RedisKeyStore tests ──────────────────────────────────────────────────────

describe('RedisKeyStore', () => {
  it('set() stores a serialized key blob', async () => {
    const client = makeMockRedisClient()
    const store = new RedisKeyStore(client)
    const blob = makeFakeBlob()

    store.set('user1', 'openai', blob)
    // Allow the async set to complete
    await new Promise(r => setTimeout(r, 10))

    expect(client.store.size).toBe(1)
    const rawKey = [...client.store.keys()][0]
    expect(rawKey).toContain('user1')
    expect(rawKey).toContain('openai')
  })

  it('getAsync() retrieves and deserializes a stored blob', async () => {
    const client = makeMockRedisClient()
    const store = new RedisKeyStore(client)
    const blob = makeFakeBlob()

    store.set('user1', 'openai', blob)
    await new Promise(r => setTimeout(r, 10))

    const retrieved = await store.getAsync('user1', 'openai')
    expect(retrieved).not.toBeUndefined()
    expect(retrieved!.ciphertext.toString('utf8')).toBe(blob.ciphertext.toString('utf8'))
    expect(retrieved!.iv.toString('base64')).toBe(blob.iv.toString('base64'))
    expect(retrieved!.tag.toString('base64')).toBe(blob.tag.toString('base64'))
    expect(retrieved!.createdAt).toBe(blob.createdAt)
  })

  it('getAsync() returns undefined for missing key', async () => {
    const client = makeMockRedisClient()
    const store = new RedisKeyStore(client)
    const result = await store.getAsync('nobody', 'nowhere')
    expect(result).toBeUndefined()
  })

  it('delete() removes the key', async () => {
    const client = makeMockRedisClient()
    const store = new RedisKeyStore(client)
    const blob = makeFakeBlob()

    store.set('user1', 'anthropic', blob)
    await new Promise(r => setTimeout(r, 10))

    store.delete('user1', 'anthropic')
    await new Promise(r => setTimeout(r, 10))

    const result = await store.getAsync('user1', 'anthropic')
    expect(result).toBeUndefined()
  })

  it('uses custom key prefix', async () => {
    const client = makeMockRedisClient()
    const store = new RedisKeyStore(client, { keyPrefix: 'myapp:keys:' })
    store.set('u', 'p', makeFakeBlob())
    await new Promise(r => setTimeout(r, 10))

    const keys = [...client.store.keys()]
    expect(keys[0]).toMatch(/^myapp:keys:/)
  })

  it('round-trips buffers with special byte patterns', async () => {
    const client = makeMockRedisClient()
    const store = new RedisKeyStore(client)
    const blob: StoredKey = {
      ciphertext: Buffer.from([0x00, 0xff, 0xab, 0xcd, 0x12, 0x34]),
      iv: Buffer.alloc(12, 0xaa),
      tag: Buffer.alloc(16, 0xbb),
      createdAt: 1234567890,
    }
    store.set('u', 'p', blob)
    await new Promise(r => setTimeout(r, 10))

    const retrieved = await store.getAsync('u', 'p')
    expect(retrieved!.ciphertext).toEqual(blob.ciphertext)
    expect(retrieved!.iv).toEqual(blob.iv)
    expect(retrieved!.tag).toEqual(blob.tag)
  })
})

// ─── RedisRateLimiter tests ───────────────────────────────────────────────────

describe('RedisRateLimiter', () => {
  it('sync check() always allows (non-blocking path)', () => {
    const client = makeMockRedisClient()
    const limiter = new RedisRateLimiter(client, { requestsPerMinute: 10 })
    const result = limiter.check('user1', 100)
    expect(result.allowed).toBe(true)
  })

  it('checkAsync() allows when under limit', async () => {
    const client = makeMockRedisClient()
    const limiter = new RedisRateLimiter(client, { requestsPerMinute: 10 })
    const result = await limiter.checkAsync('user1', 0)
    expect(result.allowed).toBe(true)
  })

  it('checkAsync() blocks when over request limit', async () => {
    const client = makeMockRedisClient()
    const limiter = new RedisRateLimiter(client, { requestsPerMinute: 5, burstAllowance: 0 })
    // Simulate 6 existing requests in Redis
    client.store.set('freerouter:rl:req:user1', '6')
    const result = await limiter.checkAsync('user1', 0)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Rate limit exceeded')
  })

  it('consume() calls Redis eval with correct keys', async () => {
    const client = makeMockRedisClient()
    const evalSpy = vi.spyOn(client, 'eval')
    const limiter = new RedisRateLimiter(client, { requestsPerMinute: 60 })
    limiter.consume('user1', 500)
    await new Promise(r => setTimeout(r, 10))
    expect(evalSpy).toHaveBeenCalled()
    const callArgs = evalSpy.mock.calls[0]
    expect(callArgs).toBeDefined()
    // Args should include the request key and token key
    expect(String(callArgs?.[2])).toContain('user1')
  })

  it('prune() is a no-op (Redis handles TTL)', () => {
    const client = makeMockRedisClient()
    const limiter = new RedisRateLimiter(client, { requestsPerMinute: 60 })
    expect(() => limiter.prune()).not.toThrow()
  })

  it('uses custom key prefix', async () => {
    const client = makeMockRedisClient()
    const evalSpy = vi.spyOn(client, 'eval')
    const limiter = new RedisRateLimiter(client, { requestsPerMinute: 60 }, { keyPrefix: 'myapp:rl:' })
    limiter.consume('user1', 0)
    await new Promise(r => setTimeout(r, 10))
    const callArgs = evalSpy.mock.calls[0]
    expect(String(callArgs?.[2])).toContain('myapp:rl:')
  })
})
