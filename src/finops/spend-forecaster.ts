import type { BudgetScope, BudgetWindow, SpendForecast } from '../types.js'
import type { SpendTracker } from './spend-tracker.js'

const WINDOW_MS: Record<BudgetWindow, number> = {
  hourly:    60 * 60 * 1_000,
  daily:     24 * 60 * 60 * 1_000,
  weekly:    7  * 24 * 60 * 60 * 1_000,
  monthly:   30 * 24 * 60 * 60 * 1_000,
  quarterly: 90 * 24 * 60 * 60 * 1_000,
  total:     Number.MAX_SAFE_INTEGER,
}

/**
 * Derives a linear burn-rate projection for a given scope + window.
 * Uses the most recent records to calculate USD/hour.
 */
export class SpendForecaster {
  private readonly tracker: SpendTracker
  private readonly atRiskHandlers: Array<(scope: BudgetScope, forecast: SpendForecast) => void> = []

  constructor(tracker: SpendTracker) {
    this.tracker = tracker
  }

  onAtRisk(handler: (scope: BudgetScope, forecast: SpendForecast) => void): void {
    this.atRiskHandlers.push(handler)
  }

  /**
   * Generate a spend forecast.
   * @param budgetUsd The policy budget for this scope/window (USD)
   */
  forecast(
    scope: BudgetScope,
    window: BudgetWindow,
    budgetUsd: number,
  ): SpendForecast {
    const summary = this.tracker.getSpend(scope, window)
    const windowMs = WINDOW_MS[window]
    const now = Date.now()
    const elapsed = now - summary.periodStart
    const remaining = windowMs - elapsed

    // USD / ms → USD / hour
    const burnRateMs = elapsed > 0 ? summary.spendUsd / elapsed : 0
    const burnRateHour = burnRateMs * 60 * 60 * 1_000

    // Project to end of window
    const projectedSpendUsd = summary.spendUsd + burnRateMs * remaining
    const projectedOverage = Math.max(0, projectedSpendUsd - budgetUsd)

    // When will budget be exhausted at current burn rate?
    let estimatedBudgetExhaustionAt: number | undefined
    const remainingBudget = budgetUsd - summary.spendUsd
    if (burnRateMs > 0 && remainingBudget > 0) {
      estimatedBudgetExhaustionAt = now + (remainingBudget / burnRateMs)
    }

    const recommendation: SpendForecast['recommendation'] =
      summary.spendUsd > budgetUsd
        ? 'over-budget'
        : projectedSpendUsd >= budgetUsd * 0.9
        ? 'at-risk'
        : 'on-track'

    const result: SpendForecast = {
      scope,
      window,
      currentSpendUsd: summary.spendUsd,
      projectedSpendUsd,
      projectedOverage,
      burnRate: burnRateHour,
      ...(estimatedBudgetExhaustionAt !== undefined && { estimatedBudgetExhaustionAt }),
      recommendation,
    }

    if (recommendation === 'at-risk' || recommendation === 'over-budget') {
      for (const h of this.atRiskHandlers) h(scope, result)
    }

    return result
  }
}
