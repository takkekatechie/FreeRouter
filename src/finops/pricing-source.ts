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
 * Pure function that converts an arbitrary parsed-JSON document into a
 * :type:`PricingManifest`. The default identity transform asserts the input
 * already matches the manifest shape; the named transformers below convert
 * popular community formats (LiteLLM, OpenRouter) into the manifest shape.
 */
export type PricingTransform = (raw: unknown) => PricingManifest

export interface HttpPricingSourceOptions {
  bearerToken?: string
  /** Request timeout ms. Default: 10 000 */
  timeoutMs?: number
  /** Extra headers forwarded verbatim. */
  headers?: Record<string, string>
  /**
   * Convert the raw JSON response into a PricingManifest. Defaults to an
   * identity transform that asserts the response is already an object.
   * Use {@link transformLiteLLM} or {@link transformOpenRouter} (or the
   * {@link liteLLMPricingSource} / {@link openRouterPricingSource} factory
   * helpers) for the two community-maintained formats.
   */
  transform?: PricingTransform
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
    private readonly options: HttpPricingSourceOptions = {},
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
            let parsedBody: unknown
            try {
              parsedBody = JSON.parse(body)
            } catch {
              reject(new Error(`[FreeRouter] PricingSource: invalid JSON from ${this.url}`))
              return
            }
            try {
              const transform = this.options.transform ?? identityTransform
              resolve(transform(parsedBody))
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
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

// ── Transformers for common community formats ────────────────────────────
//
// Each named transformer below has a Python mirror in
// `config-manager/pricing_fetcher.py`. Keep the two implementations in sync —
// any change to field names, multipliers, or skip rules must land in both.

const identityTransform: PricingTransform = raw => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      '[FreeRouter] PricingSource: response must be a JSON object shaped like ' +
        '{ provider: { modelId: { input, output, ... } } }',
    )
  }
  return raw as PricingManifest
}

/**
 * Transform LiteLLM's `model_prices_and_context_window.json` into a PricingManifest.
 *
 * LiteLLM stores prices as USD per token (very small floats); we multiply by 1e6
 * to match FreeRouter's USD-per-1M-tokens convention. Models are grouped by
 * the `litellm_provider` field. The `sample_spec` pseudo-entry is skipped.
 *
 * Source URL: see {@link LITELLM_PRICING_URL}.
 *
 * Mirror of `config-manager/pricing_fetcher.py::_transform_litellm`.
 */
export const transformLiteLLM: PricingTransform = raw => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[FreeRouter] LiteLLM source must be a JSON object')
  }
  const out: PricingManifest = {}
  for (const [modelId, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (modelId === 'sample_spec') continue
    if (entryRaw === null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue
    const entry = entryRaw as Record<string, unknown>
    const provider = entry['litellm_provider']
    if (typeof provider !== 'string' || provider === '') continue
    const inPerToken = entry['input_cost_per_token']
    const outPerToken = entry['output_cost_per_token']
    if (typeof inPerToken !== 'number' || typeof outPerToken !== 'number') continue
    const pricing: PricingManifest[string][string] = {
      input: inPerToken * 1_000_000,
      output: outPerToken * 1_000_000,
    }
    const cached = entry['cache_read_input_token_cost'] ?? entry['input_cost_per_token_cache_read']
    if (typeof cached === 'number') {
      pricing.cachedInput = cached * 1_000_000
    }
    const rpm = entry['rpm']
    if (typeof rpm === 'number') pricing.rpmLimit = Math.trunc(rpm)
    const tpm = entry['tpm']
    if (typeof tpm === 'number') pricing.tpmLimit = Math.trunc(tpm)
    if (out[provider] === undefined) out[provider] = {}
    out[provider]![modelId] = pricing
  }
  if (Object.keys(out).length === 0) {
    throw new Error('[FreeRouter] LiteLLM source contained no usable price entries')
  }
  return out
}

/**
 * Transform OpenRouter's `/v1/models` response into a PricingManifest.
 *
 * OpenRouter ids are usually `provider/model`; we split on the first slash
 * (entries without a slash fall under a synthetic `openrouter` provider).
 * Prices come as JSON strings of USD per token, so we coerce-and-scale by 1e6.
 * Free or unpriced models (both prompt and completion <= 0) are skipped.
 *
 * Source URL: see {@link OPENROUTER_PRICING_URL}.
 *
 * Mirror of `config-manager/pricing_fetcher.py::_transform_openrouter`.
 */
export const transformOpenRouter: PricingTransform = raw => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[FreeRouter] OpenRouter response must be a JSON object')
  }
  const data = (raw as { data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new Error("[FreeRouter] OpenRouter response must have a top-level 'data' array")
  }
  const out: PricingManifest = {}
  for (const entryRaw of data) {
    if (entryRaw === null || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue
    const entry = entryRaw as Record<string, unknown>
    const fullId = entry['id']
    const pricingRaw = entry['pricing']
    if (typeof fullId !== 'string') continue
    if (pricingRaw === null || typeof pricingRaw !== 'object' || Array.isArray(pricingRaw)) continue
    const pricingFields = pricingRaw as Record<string, unknown>
    const slash = fullId.indexOf('/')
    const provider = slash > 0 ? fullId.slice(0, slash) : 'openrouter'
    const modelId = slash > 0 ? fullId.slice(slash + 1) : fullId
    const promptPerToken = toFloat(pricingFields['prompt'])
    const completionPerToken = toFloat(pricingFields['completion'])
    if ((promptPerToken ?? 0) <= 0 && (completionPerToken ?? 0) <= 0) continue
    const pricing: PricingManifest[string][string] = {
      input: (promptPerToken ?? 0) * 1_000_000,
      output: (completionPerToken ?? 0) * 1_000_000,
    }
    const cached = toFloat(pricingFields['input_cache_read'])
    if (cached !== undefined && cached > 0) {
      pricing.cachedInput = cached * 1_000_000
    }
    if (out[provider] === undefined) out[provider] = {}
    out[provider]![modelId] = pricing
  }
  if (Object.keys(out).length === 0) {
    throw new Error('[FreeRouter] OpenRouter response contained no priced models')
  }
  return out
}

function toFloat(v: unknown): number | undefined {
  if (typeof v === 'number' && !Number.isNaN(v)) return v
  if (typeof v === 'string') {
    if (v.trim() === '') return undefined
    const n = Number(v)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

// ── Source URL constants & factory helpers ───────────────────────────────

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

export const OPENROUTER_PRICING_URL = 'https://openrouter.ai/api/v1/models'

/**
 * Convenience: an `HttpPricingSource` preconfigured for LiteLLM's manifest.
 *
 * @example
 *   new FreeRouter({
 *     pricingRefresh: { source: liteLLMPricingSource(), intervalMs: 3_600_000 },
 *   })
 */
export function liteLLMPricingSource(
  opts: { url?: string; bearerToken?: string; timeoutMs?: number } = {},
): HttpPricingSource {
  return new HttpPricingSource(
    opts.url ?? LITELLM_PRICING_URL,
    buildHttpOpts(transformLiteLLM, opts),
  )
}

/**
 * Convenience: an `HttpPricingSource` preconfigured for OpenRouter's
 * `/v1/models` API.
 *
 * @example
 *   new FreeRouter({
 *     pricingRefresh: { source: openRouterPricingSource(), intervalMs: 3_600_000 },
 *   })
 */
export function openRouterPricingSource(
  opts: { url?: string; bearerToken?: string; timeoutMs?: number } = {},
): HttpPricingSource {
  return new HttpPricingSource(
    opts.url ?? OPENROUTER_PRICING_URL,
    buildHttpOpts(transformOpenRouter, opts),
  )
}

function buildHttpOpts(
  transform: PricingTransform,
  opts: { bearerToken?: string; timeoutMs?: number },
): HttpPricingSourceOptions {
  const httpOpts: HttpPricingSourceOptions = { transform }
  if (opts.bearerToken !== undefined) httpOpts.bearerToken = opts.bearerToken
  if (opts.timeoutMs !== undefined) httpOpts.timeoutMs = opts.timeoutMs
  return httpOpts
}
