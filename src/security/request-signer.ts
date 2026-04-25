import { createHmac } from 'node:crypto'

/**
 * HMAC-SHA256 request signing for integrity verification.
 *
 * Produces a signature over (userId + model + messageHash + timestamp)
 * so host applications can verify that no in-flight tampering occurred.
 *
 * The signing key is always derived — the master key is never used directly.
 */
export class RequestSigner {
  constructor(private readonly enabled: boolean) {}

  /**
   * Hash the content of the messages array and sign it.
   * Returns both the content hash (for audit) and the full signature.
   * Never includes the API key.
   */
  sign(params: {
    signingKey: Buffer
    userId: string
    model: string
    messages: Array<{ role: string; content: string }>
  }): { contentHash: string; signature: string; signedAt: number } {
    const now = Date.now()

    if (!this.enabled) {
      return { contentHash: '', signature: '', signedAt: now }
    }

    // Hash message content so we never log raw prompts
    const contentHash = createHmac('sha256', params.signingKey)
      .update(JSON.stringify(params.messages))
      .digest('hex')

    const body = `${params.userId}:${params.model}:${contentHash}:${now}`
    const signature = createHmac('sha256', params.signingKey)
      .update(body)
      .digest('hex')

    return { contentHash, signature, signedAt: now }
  }

  /** Verify a previously issued signature */
  verify(params: {
    signingKey: Buffer
    userId: string
    model: string
    contentHash: string
    signature: string
    signedAt: number
    /** Reject signatures older than this (ms). Default: 60 000 */
    maxAgeMs?: number
  }): boolean {
    if (!this.enabled) return true

    const maxAge = params.maxAgeMs ?? 60_000
    if (Date.now() - params.signedAt > maxAge) return false

    const body = `${params.userId}:${params.model}:${params.contentHash}:${params.signedAt}`
    const expected = createHmac('sha256', params.signingKey)
      .update(body)
      .digest('hex')

    // Constant-time comparison
    return timingSafeEqual(expected, params.signature)
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i))
  }
  return diff === 0
}
