import type { TokenUsage } from '../types.js'

interface ModelPricing {
  input: number  // USD per 1M tokens
  output: number // USD per 1M tokens
}

/**
 * Pure function — no side effects.
 * Computes cost in USD from token usage and pricing.
 */
export function calculateCost(
  usage: TokenUsage,
  pricing: ModelPricing,
): number {
  const inputCost  = (usage.promptTokens     / 1_000_000) * pricing.input
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.output
  return round6(inputCost + outputCost)
}

/**
 * Estimate cost before sending (uses promptTokens only).
 * Used by the policy engine for pre-flight budget checks.
 * Adds a 20% buffer to account for the unknown completion length.
 */
export function estimateCost(
  promptTokens: number,
  pricing: ModelPricing,
  completionBuffer = 0.2,
): number {
  const inputCost  = (promptTokens / 1_000_000) * pricing.input
  const outputCost = (promptTokens * completionBuffer / 1_000_000) * pricing.output
  return round6(inputCost + outputCost)
}

/**
 * Rough prompt-token estimator (~4 chars per token, GPT-style).
 * Avoids needing a tokenizer dependency.
 */
export function estimatePromptTokens(messages: Array<{ content: string }>): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0)
  return Math.ceil(totalChars / 4)
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}
