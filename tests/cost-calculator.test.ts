import { describe, it, expect } from 'vitest'
import { calculateCost, estimateCost, estimatePromptTokens } from '../src/finops/cost-calculator.js'
import type { TokenUsage } from '../src/types.js'

describe('cost-calculator', () => {
  const pricing = { input: 2.00, output: 6.00 } // USD / 1M tokens

  describe('calculateCost', () => {
    it('calculates cost from token usage', () => {
      const usage: TokenUsage = {
        promptTokens: 1_000,
        completionTokens: 500,
        totalTokens: 1_500,
      }
      // input: 1000/1M * $2 = $0.002, output: 500/1M * $6 = $0.003 → $0.005
      const cost = calculateCost(usage, pricing)
      expect(cost).toBeCloseTo(0.005, 6)
    })

    it('returns 0 for zero tokens', () => {
      const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      expect(calculateCost(usage, pricing)).toBe(0)
    })

    it('handles large volumes correctly', () => {
      const usage: TokenUsage = {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        totalTokens: 2_000_000,
      }
      const cost = calculateCost(usage, pricing)
      expect(cost).toBeCloseTo(8.0, 4) // $2 + $6
    })
  })

  describe('estimateCost', () => {
    it('estimates pre-flight cost with buffer', () => {
      // 1000 prompt tokens, 20% buffer for output
      const cost = estimateCost(1_000, pricing, 0.2)
      // input: 0.002, output (200 tokens): 0.0012 → $0.0032
      expect(cost).toBeCloseTo(0.0032, 6)
    })
  })

  describe('calculateCost — cache-aware', () => {
    it('applies cachedInput rate to cached token portion', () => {
      const cachePricing = { input: 3.0, output: 15.0, cachedInput: 0.30 }
      const usage = {
        promptTokens: 1_000,
        completionTokens: 500,
        totalTokens: 1_500,
        cachedPromptTokens: 800, // 800 cached, 200 uncached
      }
      // uncached: 200/1M * 3.0 = 0.000600
      // cached:   800/1M * 0.30 = 0.000240
      // output:   500/1M * 15.0 = 0.007500
      // total = 0.008340
      expect(calculateCost(usage, cachePricing)).toBeCloseTo(0.008340, 5)
    })

    it('falls back to input rate when cachedInput is absent', () => {
      const noCachePricing = { input: 3.0, output: 15.0 }
      const usage = {
        promptTokens: 1_000,
        completionTokens: 0,
        totalTokens: 1_000,
        cachedPromptTokens: 500,
      }
      // Should treat cached tokens at full input rate → same as no cache
      const expected = calculateCost(
        { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000 },
        noCachePricing,
      )
      expect(calculateCost(usage, noCachePricing)).toBeCloseTo(expected, 6)
    })

    it('handles 100% cache hit correctly', () => {
      const cachePricing = { input: 2.0, output: 6.0, cachedInput: 0.20 }
      const usage = {
        promptTokens: 1_000,
        completionTokens: 0,
        totalTokens: 1_000,
        cachedPromptTokens: 1_000, // full cache
      }
      // 1000/1M * 0.20 = 0.0002
      expect(calculateCost(usage, cachePricing)).toBeCloseTo(0.0002, 6)
    })
  })

  describe('estimatePromptTokens', () => {
    it('estimates ~4 chars per token plus 4-token per-message overhead', () => {
      // 400 chars / 4 = 100 text tokens + 4 overhead = 104
      const messages = [{ content: 'a'.repeat(400) }]
      expect(estimatePromptTokens(messages)).toBe(104)
    })

    it('sums across multiple messages', () => {
      // (100 text + 4 overhead) × 2 messages = 208
      const messages = [
        { content: 'a'.repeat(400) },
        { content: 'b'.repeat(400) },
      ]
      expect(estimatePromptTokens(messages)).toBe(208)
    })

    it('counts CJK characters as 1 token each', () => {
      // 4 CJK + 0 ascii = 4 + 4 overhead = 8
      const messages = [{ content: '日本語テスト' }] // 6 CJK chars
      const result = estimatePromptTokens(messages)
      expect(result).toBe(10) // 6 CJK + 4 overhead
    })

    it('mixes CJK and ASCII correctly', () => {
      // 4 ASCII chars → 1 token, 2 CJK → 2 tokens, +4 overhead = 7
      const messages = [{ content: 'hi' + '日本' }] // 2 ascii + 2 CJK
      const result = estimatePromptTokens(messages)
      // ceil(2/4)=1 ascii token + 2 CJK tokens + 4 overhead = 7
      expect(result).toBe(7)
    })

    it('returns 4 for empty content (just overhead)', () => {
      expect(estimatePromptTokens([{ content: '' }])).toBe(4)
    })
  })
})
