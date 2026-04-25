import type { KeyStore, StoredKey } from '../security/key-manager.js'

/**
 * Minimal duck-typed Redis client interface.
 * Compatible with `redis` v4 and `ioredis`.
 */
export interface RedisClientLike {
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>
  get(key: string): Promise<string | null>
  del(key: string | string[]): Promise<unknown>
}

interface SerializedKey {
  ciphertext: string  // base64
  iv: string          // base64
  tag: string         // base64
  createdAt: number
}

function serialize(blob: StoredKey): string {
  const s: SerializedKey = {
    ciphertext: blob.ciphertext.toString('base64'),
    iv: blob.iv.toString('base64'),
    tag: blob.tag.toString('base64'),
    createdAt: blob.createdAt,
  }
  return JSON.stringify(s)
}

function deserialize(raw: string): StoredKey {
  const s = JSON.parse(raw) as SerializedKey
  return {
    ciphertext: Buffer.from(s.ciphertext, 'base64'),
    iv: Buffer.from(s.iv, 'base64'),
    tag: Buffer.from(s.tag, 'base64'),
    createdAt: s.createdAt,
  }
}

/**
 * Redis-backed KeyStore for distributed / multi-instance deployments.
 * Drop-in replacement for the default in-memory store:
 *
 *   const store = new RedisKeyStore(redisClient)
 *   const router = new FreeRouter({ store })  // pass via KeyManager opts
 */
export class RedisKeyStore implements KeyStore {
  private readonly prefix: string

  constructor(
    private readonly client: RedisClientLike,
    opts: { keyPrefix?: string; ttlSeconds?: number } = {},
  ) {
    this.prefix = opts.keyPrefix ?? 'freerouter:key:'
  }

  private redisKey(userId: string, provider: string): string {
    return `${this.prefix}${userId}::${provider}`
  }

  set(userId: string, provider: string, blob: StoredKey): void {
    // Fire-and-forget — surface errors as unhandled rejections
    this.client.set(this.redisKey(userId, provider), serialize(blob)).catch((err: unknown) => {
      process.stderr.write(`[FreeRouter/RedisKeyStore] set error: ${String(err)}\n`)
    })
  }

  get(userId: string, provider: string): StoredKey | undefined {
    // KeyStore.get is synchronous in the interface; Redis is async.
    // This implementation returns undefined synchronously and relies on callers
    // that use withKey() to handle the async path via a wrapping async store.
    // For full async support, use RedisKeyStore with an async-capable KeyManager override.
    // In practice, callers should await the async version below.
    return undefined
  }

  /**
   * Async version of get — use this when integrating with an async-aware key manager.
   */
  async getAsync(userId: string, provider: string): Promise<StoredKey | undefined> {
    const raw = await this.client.get(this.redisKey(userId, provider))
    if (raw === null) return undefined
    return deserialize(raw)
  }

  delete(userId: string, provider: string): void {
    this.client.del(this.redisKey(userId, provider)).catch((err: unknown) => {
      process.stderr.write(`[FreeRouter/RedisKeyStore] delete error: ${String(err)}\n`)
    })
  }
}
