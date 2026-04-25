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

  describe('estimatePromptTokens', () => {
    it('estimates ~4 chars per token', () => {
      const messages = [{ content: 'a'.repeat(400) }]
      expect(estimatePromptTokens(messages)).toBe(100)
    })

    it('sums across multiple messages', () => {
      const messages = [
        { content: 'a'.repeat(400) },
        { content: 'b'.repeat(400) },
      ]
      expect(estimatePromptTokens(messages)).toBe(200)
    })
  })
})
