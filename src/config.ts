import type {
  AuditSink,
  BudgetPolicy,
  BudgetScope,
  RateLimitConfig,
  SpendForecast,
  SpendRecord,
  SpendSummary,
} from './types.js'
import type { SpendStore } from './finops/spend-store.js'
import type { PricingSource } from './finops/pricing-source.js'
import type { CostOptimizationConfig } from './finops/cost-router.js'
import type { Rule, RulesMode } from './finops/rules-engine.js'
import type { RulesSource } from './adapters/file-rules-source.js'

export interface ProviderToggle {
  /** Set to false to skip registering this built-in provider. Default: true */
  enabled?: boolean
  /** Override default model-prefix routing for this provider */
  routingPrefixes?: string[]
}

export interface SpendPersistenceConfig {
  /**
   * Storage backend for SpendTracker records.
   * Use `FileSpendStore` for single-process deployments.
   * Implement `SpendStore` for custom backends (Redis, Postgres, S3, etc.).
   */
  store: SpendStore
  /**
   * Auto-flush interval in milliseconds.
   * Set to 0 or omit to disable scheduled flushing (ad-hoc only via `router.flushSpend()`).
   * Recommended: 60_000 (1 min) for production workloads.
   */
  intervalMs?: number
  /**
   * Register SIGINT / SIGTERM handlers that call `router.shutdown()` before exit.
   * Default: true when `store` is set.
   */
  autoFlushOnExit?: boolean
}

export interface PricingRefreshConfig {
  /** Source that provides the latest model pricing and rate-limit caps. */
  source: PricingSource
  /**
   * How often to re-fetch from the source (ms).
   * Set to 0 or omit to disable automatic refresh (manual via `router.refreshPricing()`).
   * Recommended: 3_600_000 (1 hour).
   */
  intervalMs?: number
}

export interface RulesRefreshConfig {
  /** Source of admin rules. Use `FileRulesSource` for hot-reloadable JSON. */
  source: RulesSource
  /**
   * How often to re-fetch the rule set (ms).
   * Set to 0 or omit to disable automatic refresh (manual via `router.refreshRules()`).
   */
  intervalMs?: number
}

export interface RouterConfig {
  /**
   * 32-byte hex string or Buffer used as the master AES-256-GCM key for BYOK storage.
   * If omitted, a random key is derived at startup (keys are lost on restart).
   */
  masterKey?: string | Buffer

  /** Provider to use when request.model does not embed a provider prefix */
  defaultProvider?: string

  /** Model identifier to fall back to when none is specified in the request */
  defaultModel?: string

  /** Global rate limit applied before per-user limits */
  rateLimit?: RateLimitConfig

  /** Budget policies evaluated in priority order */
  budgets?: BudgetPolicy[]

  /**
   * Allowlist of model identifiers. When non-empty, any model not in this
   * list is rejected before the request is sent.
   */
  allowedModels?: string[]

  /**
   * Provider names that are explicitly blocked, e.g. ['deepseek', 'qwen', 'zhipu'].
   * Enforced at the registry level — registration of a blocked provider throws.
   */
  blockedProviders?: string[]

  /** Maximum total characters allowed across all messages. Default 100 000 */
  maxInputLength?: number

  /**
   * Scan prompt content for injection patterns.
   * Default: true
   */
  promptInjectionGuard?: boolean

  /**
   * Sign every outbound request with HMAC-SHA256 for integrity verification.
   * Default: false
   */
  requestSigning?: boolean

  /**
   * API keys older than this TTL (ms) are treated as expired and rejected.
   * Default: undefined (keys never expire)
   */
  keyExpiryMs?: number

  /** Audit trail configuration */
  audit?: {
    enabled: boolean
    sink?: AuditSink
  }

  /**
   * Per-provider configuration.
   * Use `enabled: false` to skip registering a built-in provider (lazy loading).
   * Use `routingPrefixes` to override the default model-prefix → provider mapping.
   */
  providers?: Record<string, ProviderToggle>

  /** Override provider pricing (USD per 1 M tokens) */
  pricingOverrides?: Record<
    string,
    { input: number; output: number; cachedInput?: number }
  >

  /**
   * Persist SpendTracker records across restarts.
   * Records are loaded on `router.init()` and saved on schedule / shutdown.
   */
  spendPersistence?: SpendPersistenceConfig

  /**
   * Automatically select a cheaper candidate model for eligible requests.
   * Runs in pure in-memory computation — zero I/O, sub-millisecond overhead.
   */
  costOptimization?: CostOptimizationConfig

  /**
   * Fetch the latest model pricing and rate-limit caps from an external source.
   * Fetched data is applied to the ProviderRegistry via `addModelPricing`.
   */
  pricingRefresh?: PricingRefreshConfig

  // ─── Lifecycle hooks ─────────────────────────────────────────
  onBudgetWarning?: (scope: BudgetScope, spend: SpendSummary) => void
  onBudgetExceeded?: (scope: BudgetScope, spend: SpendSummary) => void
  onForecastAtRisk?: (scope: BudgetScope, forecast: SpendForecast) => void
  onRequestComplete?: (record: SpendRecord) => void
  /** Called after each successful pricing refresh with the number of models updated. */
  onPricingRefreshed?: (updatedCount: number) => void

  /**
   * Admin rules engine. Lets the admin override pure cost-based selection with
   * value-based directives matched on user/org/team/dept/metadata/model.
   *
   * Rules can pin a specific model, override the cost-router strategy, or block.
   * `mode` controls how rules interact with cost optimization.
   */
  rules?: { rules: Rule[]; mode: RulesMode }

  /**
   * Hot-reloadable source for admin rules. On each refresh tick, the in-memory
   * rule set is replaced atomically. If both `rules` and `rulesRefresh` are set,
   * the refresh source overwrites the programmatic rules on first fetch.
   */
  rulesRefresh?: RulesRefreshConfig

  /** Called after each successful rules refresh with the number of rules loaded. */
  onRulesRefreshed?: (count: number) => void
}
