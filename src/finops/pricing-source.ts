import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { ModelPricingEntry } from '../types.js'

/**
 * Shape of the remote pricing manifest.
 *
 * Keys are provider names matching FreeRouter's registry ("openai", "anthropic", etc.).
 * Inner keys are model IDs as used by the provider's API.
 *
 * Example JSON:
 * {
 *   "anthropic": {
 *     "claude-3-5-sonnet-20241022": { "input": 3.0, "output": 15.0, "cachedInput": 0.30 }
 *   },
 *   "openai": {
 *     "gpt-4o":      { "input": 2.50, "output": 10.0,  "cachedInput": 1.25,  "rpmLimit": 500 },
 *     "gpt-4o-mini": { "input": 0.15, "output": 0.60,  "cachedInput": 0.075, "tpmLimit": 200000 }
 *   }
 * }
 */
export interface PricingManifest {
  [providerName: string]: {
    [modelId: string]: ModelPricingEntry & {
      /** Provider-declared requests-per-minute cap (advisory — used to auto-tune rate limits). */
      rpmLimit?: number
      /** Provider-declared tokens-per-minute cap (advisory). */
      tpmLimit?: number
    }
  }
}

/**
 * Adapter that supplies up-to-date pricing and rate-limit data.
 * Implement this to pull from any source (HTTP endpoint, database, config file).
 */
export interface PricingSource {
  fetch(): Promise<PricingManifest>
}

/**
 * Fetches a JSON pricing manifest from an HTTP/HTTPS URL.
 * Uses Node.js built-in `https`/`http` — no package dependency.
 */
export class HttpPricingSource implements PricingSource {
  constructor(
    private readonly url: string,
    private readonly options: {
      bearerToken?: string
      /** Request timeout ms. Default: 10 000 */
      timeoutMs?: number
      /** Extra headers forwarded verbatim. */
      headers?: Record<string, string>
    } = {},
  ) {}

  fetch(): Promise<PricingManifest> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.url)
      const isHttps = parsed.protocol === 'https:'
      const reqFn = isHttps ? httpsRequest : httpRequest

      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...this.options.headers,
      }
      if (this.options.bearerToken !== undefined) {
        headers['Authorization'] = `Bearer ${this.options.bearerToken}`
      }

      const req = reqFn(
        {
          hostname: parsed.hostname,
          port: parsed.port !== '' ? Number(parsed.port) : undefined,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers,
        },
        res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => { body += chunk })
          res.on('end', () => {
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              reject(new Error(`[FreeRouter] PricingSource HTTP ${status}: ${this.url}`))
              return
            }
            try {
              resolve(JSON.parse(body) as PricingManifest)
            } catch {
              reject(new Error(`[FreeRouter] PricingSource: invalid JSON from ${this.url}`))
            }
          })
        },
      )

      req.on('error', reject)
      req.setTimeout(this.options.timeoutMs ?? 10_000, () => {
        req.destroy(new Error(`[FreeRouter] PricingSource timeout: ${this.url}`))
      })
      req.end()
    })
  }
}

/** In-memory pricing source — useful for tests and static overrides. */
export class StaticPricingSource implements PricingSource {
  constructor(private readonly manifest: PricingManifest) {}
  async fetch(): Promise<PricingManifest> { return this.manifest }
}
