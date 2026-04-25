import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12   // GCM recommended
const TAG_LENGTH = 16

export interface StoredKey {
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  createdAt: number
}

/**
 * Pluggable backing store for encrypted key blobs.
 * Default implementation is in-memory.
 */
export interface KeyStore {
  set(userId: string, provider: string, blob: StoredKey): void
  get(userId: string, provider: string): StoredKey | undefined
  delete(userId: string, provider: string): void
}

class InMemoryKeyStore implements KeyStore {
  private readonly store = new Map<string, StoredKey>()

  private key(userId: string, provider: string): string {
    return `${userId}::${provider}`
  }

  set(userId: string, provider: string, blob: StoredKey): void {
    this.store.set(this.key(userId, provider), blob)
  }

  get(userId: string, provider: string): StoredKey | undefined {
    return this.store.get(this.key(userId, provider))
  }

  delete(userId: string, provider: string): void {
    this.store.delete(this.key(userId, provider))
  }
}

/**
 * BYOK Key Manager
 *
 * API keys are AES-256-GCM encrypted at rest.
 * The decrypted key is placed into a Buffer, used,
 * and the buffer is zero-filled immediately after use.
 *
 * The manager itself is never able to return a plain-text key string;
 * callers receive the key inside a callback scope only.
 */
export class KeyManager {
  private readonly masterKey: Buffer
  private readonly expiryMs: number | undefined
  private readonly store: KeyStore

  constructor(opts: {
    masterKey?: string | Buffer
    keyExpiryMs?: number
    store?: KeyStore
  } = {}) {
    if (opts.masterKey !== undefined) {
      this.masterKey = typeof opts.masterKey === 'string'
        ? Buffer.from(opts.masterKey, 'hex')
        : Buffer.from(opts.masterKey)
    } else {
      // Ephemeral key — valid for the process lifetime
      this.masterKey = randomBytes(32)
    }

    if (this.masterKey.length !== 32) {
      throw new Error('[FreeRouter/KeyManager] masterKey must be exactly 32 bytes (256 bits)')
    }

    this.expiryMs = opts.keyExpiryMs
    this.store = opts.store ?? new InMemoryKeyStore()
  }

  /** Encrypt and store a user's API key. */
  setKey(userId: string, provider: string, plainKey: string): void {
    const plain = Buffer.from(plainKey, 'utf8')
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGO, this.masterKey, iv)
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
    const tag = cipher.getAuthTag()

    // Zero the plain buffer immediately
    plain.fill(0)

    this.store.set(userId, provider, {
      ciphertext,
      iv,
      tag,
      createdAt: Date.now(),
    })
  }

  /**
   * Decrypt the stored key and pass it to `fn`.
   * The buffer is zero-filled after `fn` returns (or throws).
   * The raw key is never returned from this method.
   */
  async withKey<T>(
    userId: string,
    provider: string,
    fn: (key: string) => T | Promise<T>,
  ): Promise<T> {
    const blob = this.store.get(userId, provider)
    if (blob === undefined) {
      throw new Error(
        `[FreeRouter/KeyManager] No API key set for user "${userId}" / provider "${provider}"`,
      )
    }

    if (this.expiryMs !== undefined) {
      const age = Date.now() - blob.createdAt
      if (age > this.expiryMs) {
        this.store.delete(userId, provider)
        throw new Error(
          `[FreeRouter/KeyManager] API key for user "${userId}" / provider "${provider}" has expired`,
        )
      }
    }

    const decipher = createDecipheriv(ALGO, this.masterKey, blob.iv)
    decipher.setAuthTag(blob.tag)
    const plain = Buffer.concat([decipher.update(blob.ciphertext), decipher.final()])

    try {
      const keyStr = plain.toString('utf8')
      return await fn(keyStr)
    } finally {
      // Zero on every exit path
      plain.fill(0)
    }
  }

  /** Atomically re-encrypt a key (key rotation). */
  rotateKey(userId: string, provider: string, newPlainKey: string): void {
    // Overwrite atomically — old blob is replaced in the same store operation
    this.setKey(userId, provider, newPlainKey)
  }

  deleteKey(userId: string, provider: string): void {
    this.store.delete(userId, provider)
  }

  hasKey(userId: string, provider: string): boolean {
    return this.store.get(userId, provider) !== undefined
  }

  /**
   * Derive a stable per-user HMAC key for request signing.
   * Uses HKDF-like derivation from the master key — never exposes it.
   */
  deriveHmacKey(userId: string): Buffer {
    const hmac = createHmac('sha256', this.masterKey)
    hmac.update(`hmac-key:${userId}`)
    return hmac.digest()
  }
}
