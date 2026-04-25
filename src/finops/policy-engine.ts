import type { BudgetPolicy, ChatRequest, PolicyDecision, RequestContext } from '../types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { SpendTracker } from './spend-tracker.js'
import type { SpendForecaster } from './spend-forecaster.js'
import type { RateLimiterLike } from './rate-limiter.js'
import { estimateCost, estimatePromptTokens } from './cost-calculator.js'

export class PolicyEngine {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly tracker: SpendTracker,
    private readonly forecaster: SpendForecaster | undefined,
    private readonly rateLimiter: RateLimiterLike | undefined,
    private readonly policies: BudgetPolicy[],
    private readonly pricingOverrides: Record<string, { input: number; output: number }> = {},
  ) {}

  evaluate(
    userId: string,
    req: ChatRequest,
    context: RequestContext,
  ): PolicyDecision {
    const { provider, modelName } = this.registry.resolveFromModel(req.model)
    // Preserve the full original model string (including provider/ prefix if present)
    // so the router can re-resolve the provider after policy evaluation.
    const originalModel = req.model

    // ── 1. Rate limit check ──────────────────────────────────
    if (this.rateLimiter !== undefined) {
      const rateLimitKey = context.teamId ?? userId
      const rlResult = this.rateLimiter.check(rateLimitKey, estimatePromptTokens(req.messages))
      if (!rlResult.allowed) {
        return {
          allowed: false,
          originalModel,
          effectiveModel: originalModel,
          estimatedCostUsd: 0,
          warnings: [],
          ...(rlResult.reason !== undefined && { blockedReason: rlResult.reason }),
        }
      }
    }

    // ── 2. Cost estimation ───────────────────────────────────
    const pricingKey = Object.keys(this.pricingOverrides).find(k => modelName.startsWith(k))
    const pricing = pricingKey !== undefined
      ? (this.pricingOverrides[pricingKey] ?? provider.pricing(modelName))
      : provider.pricing(modelName)

    const estimatedTokens = estimatePromptTokens(req.messages)
    const estimatedCostUsd = estimateCost(estimatedTokens, pricing)

    // ── 3. Budget cascade check ──────────────────────────────
    const budgetResult = this.tracker.checkPolicies({
      userId,
      ...(context.orgId !== undefined && { orgId: context.orgId }),
      ...(context.teamId !== undefined && { teamId: context.teamId }),
      ...(context.departmentId !== undefined && { departmentId: context.departmentId }),
      model: modelName,
      estimatedCostUsd,
      policies: this.policies,
    })

    if (!budgetResult.allowed) {
      return {
        allowed: false,
        originalModel,
        effectiveModel: originalModel,
        estimatedCostUsd,
        warnings: budgetResult.warnings,
        ...(budgetResult.blockedReason !== undefined && { blockedReason: budgetResult.blockedReason }),
        ...(budgetResult.policyId !== undefined && { policyId: budgetResult.policyId }),
      }
    }

    // ── 4. Model downgrade ───────────────────────────────────
    let effectiveModel = originalModel
    if (budgetResult.downgradeTo !== undefined) {
      effectiveModel = budgetResult.downgradeTo
    }

    // ── 5. Forecast (optional) ───────────────────────────────
    let forecast = undefined
    if (this.forecaster !== undefined && this.policies.length > 0) {
      const bestPolicy = this.policies
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .find(p => p.scope.type === 'org' || p.scope.type === 'global')
      if (bestPolicy !== undefined) {
        try {
          forecast = this.forecaster.forecast(bestPolicy.scope, bestPolicy.window, bestPolicy.maxSpendUsd)
        } catch {
          // forecast failure should not block the request
        }
      }
    }

    return {
      allowed: true,
      originalModel,
      effectiveModel,
      estimatedCostUsd,
      warnings: budgetResult.warnings,
      ...(budgetResult.policyId !== undefined && { policyId: budgetResult.policyId }),
      ...(forecast !== undefined && { forecast }),
    }
  }
}
