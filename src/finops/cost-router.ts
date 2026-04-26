import type { ProviderRegistry } from '../providers/registry.js'

export type CostStrategy =
  | 'cheapest'     // always route to the lowest-cost candidate
  | 'balanced'     // prefer cheaper models but only when savings exceed the threshold
  | 'performance'  // no-op: always use the requested model as-is

export interface CostOptimizationConfig {
  strategy: CostStrategy
  /**
   * Ordered list of candidate model identifiers (e.g. "gemini-2.0-flash-lite").
   * The router picks the cheapest candidate whose input price is lower than the
   * requested model's price (or the cheapest overall for strategy "cheapest").
   * Must be resolvable via the ProviderRegistry — unknown candidates are silently skipped.
   */
  candidateModels: string[]
  /**
   * Minimum estimated cost (USD) before optimization kicks in.
   * Requests cheaper than this are sent on the original model regardless of strategy.
   * Default: 0 (always optimize).
   */
  minCostThresholdUsd?: number
  /**
   * Only optimize requests with priority !== 'realtime'.
   * Default: false (optimize all requests matching strategy).
   */
  batchOnly?: boolean
}

interface Pricing { input: number; output: number; cachedInput?: number }

export class CostRouter {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly config: CostOptimizationConfig,
  ) {}

  /**
   * Returns the most cost-effective model for this request.
   * Pure in-memory computation — no I/O, guaranteed sub-millisecond.
   *
   * @param requestedModel   The model the caller asked for.
   * @param estimatedTokens  Rough prompt-token count (from estimatePromptTokens).
   * @param isRealtime       True when ChatRequest.priority === 'realtime'.
   */
  selectModel(
    requestedModel: string,
    estimatedTokens: number,
    isRealtime = false,
    overrides?: { strategy?: CostStrategy; candidateModels?: string[] },
  ): string {
    const strategy = overrides?.strategy ?? this.config.strategy
    const candidates = overrides?.candidateModels ?? this.config.candidateModels

    if (strategy === 'performance') return requestedModel
    if (this.config.batchOnly === true && isRealtime) return requestedModel

    const basePricing = this.resolvePricing(requestedModel)
    if (basePricing === undefined) return requestedModel

    const baseCost = this.inputCost(estimatedTokens, basePricing)

    if (
      this.config.minCostThresholdUsd !== undefined &&
      baseCost < this.config.minCostThresholdUsd
    ) {
      return requestedModel
    }

    let bestModel = requestedModel
    let bestCost = baseCost

    for (const candidate of candidates) {
      if (candidate === requestedModel) continue
      const pricing = this.resolvePricing(candidate)
      if (pricing === undefined) continue
      const cost = this.inputCost(estimatedTokens, pricing)
      if (cost < bestCost) {
        bestCost = cost
        bestModel = candidate
      }
    }

    return bestModel
  }

  private resolvePricing(model: string): Pricing | undefined {
    try {
      const { provider, modelName } = this.registry.resolveFromModel(model)
      return provider.pricing(modelName)
    } catch {
      return undefined
    }
  }

  private inputCost(tokens: number, pricing: Pricing): number {
    return (tokens / 1_000_000) * pricing.input
  }
}
