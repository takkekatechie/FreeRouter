import type {
  AuditSink,
  BudgetPolicy,
  BudgetScope,
  RateLimitConfig,
  SpendForecast,
  SpendRecord,
  SpendSummary,
} from './types.js'

export interface ProviderToggle {
  /** Set to false to skip registering this built-in provider. Default: true */
  enabled?: boolean
  /** Override default model-prefix routing for this provider */
  routingPrefixes?: string[]
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
    { input: number; output: number }
  >

  // ─── Lifecycle hooks ─────────────────────────────────────────
  onBudgetWarning?: (scope: BudgetScope, spend: SpendSummary) => void
  onBudgetExceeded?: (scope: BudgetScope, spend: SpendSummary) => void
  onForecastAtRisk?: (scope: BudgetScope, forecast: SpendForecast) => void
  onRequestComplete?: (record: SpendRecord) => void
}
