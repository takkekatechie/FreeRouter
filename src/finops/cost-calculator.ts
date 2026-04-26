import type { TokenUsage } from '../types.js'

interface ModelPricing {
  input: number        // USD per 1M tokens
  output: number       // USD per 1M tokens
  cachedInput?: number // USD per 1M cached prompt tokens (defaults to input)
}

/**
 * Pure function — no side effects.
 * Computes cost in USD from token usage and pricing.
 * When usage.cachedPromptTokens is set, the cached portion is priced at
 * pricing.cachedInput (e.g. 10 % for Anthropic, 50 % for OpenAI).
 */
export function calculateCost(
  usage: TokenUsage,
  pricing: ModelPricing,
): number {
  const cached = usage.cachedPromptTokens ?? 0
  const uncached = usage.promptTokens - cached
  const cachedRate = pricing.cachedInput ?? pricing.input

  const inputCost  = (uncached / 1_000_000) * pricing.input
               + (cached   / 1_000_000) * cachedRate
  const outputCost = (usage.completionTokens / 1_000_000) * pricing.output
  return round6(inputCost + outputCost)
}

/**
 * Estimate cost before sending (uses promptTokens only, no completion data yet).
 * Used by the policy engine for pre-flight budget checks.
 * Adds a 20 % buffer to account for the unknown completion length.
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
 * Token estimator that is aware of CJK character density.
 *
 * Approximation rules (zero-dep, no tokenizer):
 * - CJK (U+3000–U+9FFF, U+F900–U+FAFF, U+20000–U+2FA1F): 1 char ≈ 1 token
 * - Everything else: 4 chars ≈ 1 token  (GPT/Claude BPE rule of thumb)
 * - Role prefix overhead: +4 tokens per message
 *
 * Accuracy is ±20 % on mixed content and ±10 % on ASCII prose.
 */
export function estimatePromptTokens(messages: Array<{ content: string }>): number {
  let tokens = 0
  for (const m of messages) {
    tokens += 4 // role + framing overhead
    let ascii = 0
    for (const cp of m.content) {
      const c = cp.codePointAt(0) ?? 0
      if (isCjk(c)) {
        tokens += Math.ceil(ascii / 4)
        ascii = 0
        tokens += 1
      } else {
        ascii++
      }
    }
    tokens += Math.ceil(ascii / 4)
  }
  return tokens
}

function isCjk(cp: number): boolean {
  return (cp >= 0x3000  && cp <= 0x9FFF)   // CJK unified + kana + punctuation
      || (cp >= 0xF900  && cp <= 0xFAFF)   // CJK compatibility ideographs
      || (cp >= 0x20000 && cp <= 0x2FA1F)  // CJK extension B–F and supplement
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}
