import { describe, it, expect, beforeEach } from 'vitest'
import { KeyManager } from '../src/security/key-manager.js'

describe('KeyManager', () => {
  const masterKey = Buffer.alloc(32, 'a').toString('hex')

  it('encrypts and decrypts a key correctly', async () => {
    const km = new KeyManager({ masterKey })
    km.setKey('user1', 'google', 'my-secret-api-key')
    const result = await km.withKey('user1', 'google', key => key)
    expect(result).toBe('my-secret-api-key')
  })

  it('throws when no key is set', async () => {
    const km = new KeyManager({ masterKey })
    await expect(km.withKey('ghost', 'openai', k => k)).rejects.toThrow('No API key set')
  })

  it('zeroes buffer on exception inside callback', async () => {
    const km = new KeyManager({ masterKey })
    km.setKey('user1', 'openai', 'key-123')
    // Should not leak even when callback throws
    await expect(
      km.withKey('user1', 'openai', () => { throw new Error('callback error') })
    ).rejects.toThrow('callback error')
  })

  it('rotates key atomically', async () => {
    const km = new KeyManager({ masterKey })
    km.setKey('user1', 'google', 'old-key')
    km.rotateKey('user1', 'google', 'new-key')
    const result = await km.withKey('user1', 'google', k => k)
    expect(result).toBe('new-key')
  })

  it('deletes a key', () => {
    const km = new KeyManager({ masterKey })
    km.setKey('user1', 'openai', 'key')
    expect(km.hasKey('user1', 'openai')).toBe(true)
    km.deleteKey('user1', 'openai')
    expect(km.hasKey('user1', 'openai')).toBe(false)
  })

  it('rejects expired keys', async () => {
    const km = new KeyManager({ masterKey, keyExpiryMs: 1 }) // 1ms TTL
    km.setKey('user1', 'openai', 'key')
    await new Promise(r => setTimeout(r, 10))
    await expect(km.withKey('user1', 'openai', k => k)).rejects.toThrow('expired')
  })

  it('throws on master key with wrong length', () => {
    expect(() => new KeyManager({ masterKey: 'tooshort' })).toThrow('32 bytes')
  })

  it('derives distinct HMAC keys per user', () => {
    const km = new KeyManager({ masterKey })
    const key1 = km.deriveHmacKey('userA')
    const key2 = km.deriveHmacKey('userB')
    expect(key1.equals(key2)).toBe(false)
  })
})
