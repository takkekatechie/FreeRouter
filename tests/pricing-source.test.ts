import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { StaticPricingSource } from '../src/finops/pricing-source.js'
import { FilePricingSource } from '../src/adapters/file-pricing-source.js'
import type { PricingManifest } from '../src/finops/pricing-source.js'

const MANIFEST: PricingManifest = {
  anthropic: {
    'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cachedInput: 0.30, rpmLimit: 500 },
    'claude-3-haiku-20240307':    { input: 0.25, output: 1.25, cachedInput: 0.03 },
  },
  openai: {
    'gpt-4o':      { input: 2.50, output: 10.0, cachedInput: 1.25 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
  },
}

// ── StaticPricingSource ─────────────────────────────────────────────────────

describe('StaticPricingSource', () => {
  it('fetch() returns the manifest passed to constructor', async () => {
    const source = new StaticPricingSource(MANIFEST)
    const result = await source.fetch()
    expect(result).toEqual(MANIFEST)
  })

  it('fetch() returns the same reference each call', async () => {
    const source = new StaticPricingSource(MANIFEST)
    const a = await source.fetch()
    const b = await source.fetch()
    expect(a).toBe(b)
  })

  it('handles empty manifest', async () => {
    const source = new StaticPricingSource({})
    expect(await source.fetch()).toEqual({})
  })
})

// ── FilePricingSource ───────────────────────────────────────────────────────

describe('FilePricingSource', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = join(tmpdir(), `fr-pricing-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, { recursive: true })
    filePath = join(dir, 'pricing.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('fetch() parses a valid JSON pricing file', async () => {
    await writeFile(filePath, JSON.stringify(MANIFEST), 'utf8')
    const source = new FilePricingSource(filePath)
    const result = await source.fetch()
    expect(result.anthropic?.['claude-3-5-sonnet-20241022']?.input).toBe(3.0)
    expect(result.openai?.['gpt-4o-mini']?.output).toBe(0.60)
  })

  it('fetch() re-reads file on each call — reflects hot-swap updates', async () => {
    const v1: PricingManifest = { openai: { 'gpt-4o': { input: 2.50, output: 10.0 } } }
    const v2: PricingManifest = { openai: { 'gpt-4o': { input: 1.00, output: 5.0 } } }

    await writeFile(filePath, JSON.stringify(v1), 'utf8')
    const source = new FilePricingSource(filePath)
    expect((await source.fetch()).openai?.['gpt-4o']?.input).toBe(2.50)

    // Overwrite file — next fetch should see new data
    await writeFile(filePath, JSON.stringify(v2), 'utf8')
    expect((await source.fetch()).openai?.['gpt-4o']?.input).toBe(1.00)
  })

  it('fetch() throws when file does not exist', async () => {
    const source = new FilePricingSource(join(dir, 'nonexistent.json'))
    await expect(source.fetch()).rejects.toThrow()
  })

  it('fetch() throws when file contains invalid JSON', async () => {
    await writeFile(filePath, 'INVALID_JSON', 'utf8')
    const source = new FilePricingSource(filePath)
    await expect(source.fetch()).rejects.toThrow()
  })

  it('preserves rpmLimit and tpmLimit advisory fields', async () => {
    await writeFile(filePath, JSON.stringify(MANIFEST), 'utf8')
    const source = new FilePricingSource(filePath)
    const result = await source.fetch()
    expect(result.anthropic?.['claude-3-5-sonnet-20241022']?.rpmLimit).toBe(500)
  })
})

// ── HttpPricingSource — error paths via local HTTP server ────────────────────

describe('HttpPricingSource', () => {
  let server: Server
  let port: number
  let responseStatus = 200
  let responseBody = JSON.stringify(MANIFEST)

  beforeEach(async () => {
    responseStatus = 200
    responseBody = JSON.stringify(MANIFEST)
    server = createServer((_req, res) => {
      res.writeHead(responseStatus, { 'Content-Type': 'application/json' })
      res.end(responseBody)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    )
  })

  it('fetch() retrieves and parses JSON manifest from HTTP server', async () => {
    const { HttpPricingSource } = await import('../src/finops/pricing-source.js')
    const source = new HttpPricingSource(`http://127.0.0.1:${port}/pricing.json`)
    const result = await source.fetch()
    expect(result.anthropic?.['claude-3-5-sonnet-20241022']?.input).toBe(3.0)
  })

  it('fetch() rejects on non-2xx status', async () => {
    const { HttpPricingSource } = await import('../src/finops/pricing-source.js')
    responseStatus = 403
    responseBody = 'Forbidden'
    const source = new HttpPricingSource(`http://127.0.0.1:${port}/pricing.json`)
    await expect(source.fetch()).rejects.toThrow('403')
  })

  it('fetch() rejects when server returns invalid JSON', async () => {
    const { HttpPricingSource } = await import('../src/finops/pricing-source.js')
    responseBody = 'NOT_JSON'
    const source = new HttpPricingSource(`http://127.0.0.1:${port}/pricing.json`)
    await expect(source.fetch()).rejects.toThrow(/invalid JSON/i)
  })

  it('fetch() times out after configured timeoutMs', async () => {
    // Replace server handler with one that hangs
    const { HttpPricingSource } = await import('../src/finops/pricing-source.js')
    server.removeAllListeners('request')
    server.on('request', (_req, res) => {
      // Never respond — simulate hang
      res.socket?.setTimeout(0)
    })
    const source = new HttpPricingSource(`http://127.0.0.1:${port}/pricing.json`, {
      timeoutMs: 100,
    })
    await expect(source.fetch()).rejects.toThrow()
  }, 5_000)

  it('fetch() applies a custom transform when supplied', async () => {
    const { HttpPricingSource, transformLiteLLM } = await import('../src/finops/pricing-source.js')
    responseBody = JSON.stringify({
      'gpt-4o': {
        litellm_provider: 'openai',
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 1e-5,
      },
    })
    const source = new HttpPricingSource(`http://127.0.0.1:${port}/litellm.json`, {
      transform: transformLiteLLM,
    })
    const result = await source.fetch()
    expect(result.openai?.['gpt-4o']?.input).toBe(2.5)
    expect(result.openai?.['gpt-4o']?.output).toBe(10.0)
  })

  it('fetch() rejects on identity-transform shape mismatch', async () => {
    const { HttpPricingSource } = await import('../src/finops/pricing-source.js')
    responseBody = JSON.stringify(['not', 'an', 'object'])
    const source = new HttpPricingSource(`http://127.0.0.1:${port}/bad.json`)
    await expect(source.fetch()).rejects.toThrow(/JSON object/)
  })
})

// ── Transformers ────────────────────────────────────────────────────────────

describe('transformLiteLLM', () => {
  it('groups by litellm_provider and scales prices to per-1M tokens', async () => {
    const { transformLiteLLM } = await import('../src/finops/pricing-source.js')
    const result = transformLiteLLM({
      sample_spec: { note: 'should be skipped' },
      'gpt-4o': {
        litellm_provider: 'openai',
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 1.25e-6,
        rpm: 500,
        tpm: 200_000,
      },
      'claude-3-5-sonnet-20241022': {
        litellm_provider: 'anthropic',
        input_cost_per_token: 3e-6,
        output_cost_per_token: 1.5e-5,
      },
      'no-pricing-model': { litellm_provider: 'foo' }, // missing prices → skip
      'no-provider': { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 }, // skip
    })
    expect(Object.keys(result).sort()).toEqual(['anthropic', 'openai'])
    expect(result.openai!['gpt-4o']!.input).toBe(2.5)
    expect(result.openai!['gpt-4o']!.output).toBe(10.0)
    expect(result.openai!['gpt-4o']!.cachedInput).toBe(1.25)
    expect(result.openai!['gpt-4o']!.rpmLimit).toBe(500)
    expect(result.openai!['gpt-4o']!.tpmLimit).toBe(200_000)
    expect(result.anthropic!['claude-3-5-sonnet-20241022']!.input).toBe(3.0)
  })

  it('falls back to input_cost_per_token_cache_read when cache_read_input_token_cost is missing', async () => {
    const { transformLiteLLM } = await import('../src/finops/pricing-source.js')
    const result = transformLiteLLM({
      'gpt-4o': {
        litellm_provider: 'openai',
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 1e-5,
        input_cost_per_token_cache_read: 0.625e-6,
      },
    })
    expect(result.openai!['gpt-4o']!.cachedInput).toBeCloseTo(0.625)
  })

  it('rejects non-object input', async () => {
    const { transformLiteLLM } = await import('../src/finops/pricing-source.js')
    expect(() => transformLiteLLM(null)).toThrow()
    expect(() => transformLiteLLM([])).toThrow()
    expect(() => transformLiteLLM('string')).toThrow()
  })

  it('rejects when no usable price entries are present', async () => {
    const { transformLiteLLM } = await import('../src/finops/pricing-source.js')
    expect(() => transformLiteLLM({ sample_spec: {} })).toThrow(/no usable price/i)
  })
})

describe('transformOpenRouter', () => {
  it('splits id on first slash and scales string prices to per-1M tokens', async () => {
    const { transformOpenRouter } = await import('../src/finops/pricing-source.js')
    const result = transformOpenRouter({
      data: [
        {
          id: 'openai/gpt-4o',
          pricing: {
            prompt: '0.0000025',
            completion: '0.00001',
            input_cache_read: '0.00000125',
          },
        },
        {
          id: 'anthropic/claude-3.5-sonnet',
          pricing: { prompt: '0.000003', completion: '0.000015' },
        },
        { id: 'free/some-model', pricing: { prompt: '0', completion: '0' } }, // skip
        { id: 'broken', pricing: 'not-a-dict' }, // skip
      ],
    })
    expect(Object.keys(result).sort()).toEqual(['anthropic', 'openai'])
    expect(result.openai!['gpt-4o']!.input).toBe(2.5)
    expect(result.openai!['gpt-4o']!.cachedInput).toBe(1.25)
    expect(result.anthropic!['claude-3.5-sonnet']!.output).toBe(15.0)
  })

  it('falls back to synthetic openrouter provider when id has no slash', async () => {
    const { transformOpenRouter } = await import('../src/finops/pricing-source.js')
    const result = transformOpenRouter({
      data: [{ id: 'special-model', pricing: { prompt: '0.000001', completion: '0.000002' } }],
    })
    expect(result.openrouter!['special-model']!.input).toBe(1.0)
    expect(result.openrouter!['special-model']!.output).toBe(2.0)
  })

  it("rejects when 'data' is missing or not an array", async () => {
    const { transformOpenRouter } = await import('../src/finops/pricing-source.js')
    expect(() => transformOpenRouter({})).toThrow(/'data'/)
    expect(() => transformOpenRouter({ data: 'not array' })).toThrow(/'data'/)
  })

  it('rejects when no priced models are present', async () => {
    const { transformOpenRouter } = await import('../src/finops/pricing-source.js')
    expect(() =>
      transformOpenRouter({
        data: [{ id: 'free/x', pricing: { prompt: '0', completion: '0' } }],
      }),
    ).toThrow(/no priced models/i)
  })
})

describe('factory helpers', () => {
  it('liteLLMPricingSource defaults to LITELLM_PRICING_URL with the LiteLLM transform', async () => {
    const mod = await import('../src/finops/pricing-source.js')
    const src = mod.liteLLMPricingSource()
    // Smoke check: it's an HttpPricingSource configured with the canonical URL.
    expect(src).toBeInstanceOf(mod.HttpPricingSource)
    expect(mod.LITELLM_PRICING_URL).toMatch(/^https:\/\/raw\.githubusercontent\.com/)
  })

  it('openRouterPricingSource defaults to OPENROUTER_PRICING_URL with the OpenRouter transform', async () => {
    const mod = await import('../src/finops/pricing-source.js')
    const src = mod.openRouterPricingSource()
    expect(src).toBeInstanceOf(mod.HttpPricingSource)
    expect(mod.OPENROUTER_PRICING_URL).toBe('https://openrouter.ai/api/v1/models')
  })
})
