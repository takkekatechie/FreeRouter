import type {
  BudgetPolicy,
  BudgetScope,
  BudgetWindow,
  ChargebackReport,
  ChatRequest,
  ChatResponse,
  HealthStatus,
  ModelPricingEntry,
  ProviderHealth,
  RequestContext,
  RouterEventMap,
  RouterMetrics,
  SpendForecast,
  SpendRecord,
  SpendSummary,
  StreamChunk,
} from './types.js'
import type { RouterConfig } from './config.js'
import type { BaseProvider } from './providers/base-provider.js'
import type { FreeRouterPlugin } from './plugin.js'
import { ProviderRegistry } from './providers/registry.js'
import { KeyManager } from './security/key-manager.js'
import { AuditLogger } from './security/audit-logger.js'
import { RequestSigner } from './security/request-signer.js'
import { InputValidator } from './security/input-validator.js'
import { SpendTracker } from './finops/spend-tracker.js'
import { SpendForecaster } from './finops/spend-forecaster.js'
import { ChargebackEngine } from './finops/chargeback.js'
import { RateLimiter } from './finops/rate-limiter.js'
import type { RateLimiterLike } from './finops/rate-limiter.js'
import { PolicyEngine } from './finops/policy-engine.js'
import { CostRouter } from './finops/cost-router.js'
import { RulesEngine, type Rule, type RuleDecision } from './finops/rules-engine.js'
import { calculateCost, estimatePromptTokens } from './finops/cost-calculator.js'
import { loadConfigFile, loadConfigFromEnv, mergeConfigs, validateConfigKeys } from './config-loader.js'
import { TypedEventEmitter } from './router-events.js'
import { MetricsCollector } from './metrics-collector.js'

export class FreeRouter {
  private readonly registry: ProviderRegistry
  private readonly keyManager: KeyManager
  private readonly audit: AuditLogger
  private readonly signer: RequestSigner
  private readonly validator: InputValidator
  private readonly tracker: SpendTracker
  private readonly forecaster: SpendForecaster
  private readonly chargeback: ChargebackEngine
  private readonly rateLimiter: RateLimiterLike | undefined
  private readonly policyEngine: PolicyEngine
  private readonly costRouter: CostRouter | undefined
  private readonly rulesEngine: RulesEngine | undefined
  private readonly config: RouterConfig
  private readonly policies: BudgetPolicy[]

  // Hot-reload state
  private readonly events = new TypedEventEmitter<RouterEventMap>()
  private readonly inflight = new Map<string, Set<Promise<unknown>>>()
  private readonly runtimeBlocked = new Set<string>()
  // All providers ever seen (registry + removed) — used by healthCheck
  private readonly allKnownProviders = new Set<string>()

  // Metrics & health
  private readonly metricsCollector = new MetricsCollector()
  private readonly startTime = Date.now()

  // Plugin dedup
  private readonly installedPlugins = new Set<string>()

  // Persistence & refresh
  private spendFlushTimer: ReturnType<typeof setInterval> | undefined
  private pricingRefreshTimer: ReturnType<typeof setInterval> | undefined
  private rulesRefreshTimer: ReturnType<typeof setInterval> | undefined
  private readonly exitHandlers = new Map<string, () => void>()
  private initPromise: Promise<void> | undefined

  // ── Static factory methods ────────────────────────────────

  /**
   * Create a router from a JSON/YAML/TOML config file.
   * Format is auto-detected from file extension.
   * Automatically calls `init()` so spend history and pricing are loaded before first use.
   */
  static async fromFile(filePath: string, overrides?: Partial<RouterConfig>): Promise<FreeRouter> {
    const fileConfig = await loadConfigFile(filePath)
    const unknownKeys = validateConfigKeys(fileConfig as Record<string, unknown>)
    if (unknownKeys.length > 0) {
      process.stderr.write(`[FreeRouter] Warning: unknown config keys: ${unknownKeys.join(', ')}\n`)
    }
    const merged = mergeConfigs(fileConfig, overrides) as RouterConfig
    const router = new FreeRouter(merged)
    await router.init()
    return router
  }

  /**
   * Create a router from the path in FREEROUTER_CONFIG env var.
   * Automatically calls `init()` so spend history and pricing are loaded before first use.
   */
  static async fromEnv(overrides?: Partial<RouterConfig>): Promise<FreeRouter> {
    const fileConfig = await loadConfigFromEnv()
    const merged = mergeConfigs(fileConfig, overrides) as RouterConfig
    const router = new FreeRouter(merged)
    await router.init()
    return router
  }

  constructor(config: RouterConfig = {}) {
    this.config = config
    this.policies = config.budgets ?? []

    this.registry = new ProviderRegistry(config.blockedProviders ?? [], config.providers)

    this.keyManager = new KeyManager({
      ...(config.masterKey !== undefined && { masterKey: config.masterKey }),
      ...(config.keyExpiryMs !== undefined && { keyExpiryMs: config.keyExpiryMs }),
    })

    this.audit = new AuditLogger({
      enabled: config.audit?.enabled !== false,
      ...(config.audit?.sink !== undefined && { sink: config.audit.sink }),
    })

    this.signer = new RequestSigner(config.requestSigning === true)

    this.validator = new InputValidator({
      ...(config.maxInputLength !== undefined && { maxInputLength: config.maxInputLength }),
      ...(config.promptInjectionGuard !== undefined && { promptInjectionGuard: config.promptInjectionGuard }),
      ...(config.allowedModels !== undefined && { allowedModels: config.allowedModels }),
    })

    this.tracker = new SpendTracker()
    this.tracker.on('budget:warning', (scope, summary, policyId) => {
      config.onBudgetWarning?.(scope, summary)
      this.audit.budgetWarning({
        userId: scope.type === 'user' ? scope.userId : 'system',
        policyId: policyId ?? 'unknown',
        costUsd: summary.spendUsd,
        reason: 'Budget threshold reached',
      })
    })
    this.tracker.on('budget:exceeded', (scope, summary, policyId) => {
      config.onBudgetExceeded?.(scope, summary)
      this.audit.budgetExceeded({
        userId: scope.type === 'user' ? scope.userId : 'system',
        policyId: policyId ?? 'unknown',
        costUsd: summary.spendUsd,
        reason: 'Budget exceeded',
      })
    })

    this.forecaster = new SpendForecaster(this.tracker)
    this.forecaster.onAtRisk((scope, forecast) => {
      config.onForecastAtRisk?.(scope, forecast)
    })

    this.chargeback = new ChargebackEngine(this.tracker)

    this.rateLimiter = config.rateLimit !== undefined
      ? new RateLimiter(config.rateLimit)
      : undefined

    this.policyEngine = new PolicyEngine(
      this.registry,
      this.tracker,
      this.forecaster,
      this.rateLimiter,
      this.policies,
      config.pricingOverrides ?? {},
    )

    this.costRouter = config.costOptimization !== undefined
      ? new CostRouter(this.registry, config.costOptimization)
      : undefined

    this.rulesEngine = config.rules !== undefined
      ? new RulesEngine(config.rules)
      : config.rulesRefresh !== undefined
        ? new RulesEngine({ rules: [], mode: 'pin-wins' })
        : undefined

    // Seed known providers from the initial registry
    for (const name of this.registry.list()) {
      this.allKnownProviders.add(name.toLowerCase())
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /**
   * Load persisted spend records from the configured SpendStore and
   * fetch the initial pricing manifest from the configured PricingSource.
   *
   * Called automatically by `fromFile` and `fromEnv`.
   * When using `new FreeRouter(config)` directly, call `await router.init()` before
   * processing requests if you want historical spend data loaded.
   *
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async init(): Promise<void> {
    if (this.initPromise !== undefined) {
      await this.initPromise
      return
    }
    this.initPromise = this._initialize()
    await this.initPromise
  }

  private async _initialize(): Promise<void> {
    // Restore persisted spend records
    const persistence = this.config.spendPersistence
    if (persistence !== undefined) {
      const records = await persistence.store.load()
      for (const r of records) this.tracker.recordSpend(r)

      if (persistence.intervalMs !== undefined && persistence.intervalMs > 0) {
        this.spendFlushTimer = setInterval(
          () => { void this.flushSpend() },
          persistence.intervalMs,
        )
        // Don't keep the process alive just for the timer
        this.spendFlushTimer.unref?.()
      }

      // Default: register exit handlers when a store is configured
      if (persistence.autoFlushOnExit !== false) {
        this._registerExitHandlers()
      }
    }

    // Load initial pricing from the configured source
    if (this.config.pricingRefresh !== undefined) {
      await this.refreshPricing()

      const { intervalMs } = this.config.pricingRefresh
      if (intervalMs !== undefined && intervalMs > 0) {
        this.pricingRefreshTimer = setInterval(
          () => { void this.refreshPricing() },
          intervalMs,
        )
        this.pricingRefreshTimer.unref?.()
      }
    }

    // Load initial admin rules from the configured source
    if (this.config.rulesRefresh !== undefined && this.rulesEngine !== undefined) {
      await this.refreshRules()

      const { intervalMs } = this.config.rulesRefresh
      if (intervalMs !== undefined && intervalMs > 0) {
        this.rulesRefreshTimer = setInterval(
          () => { void this.refreshRules() },
          intervalMs,
        )
        this.rulesRefreshTimer.unref?.()
      }
    }
  }

  /**
   * Flush current spend records to the configured SpendStore.
   * No-op when no store is configured.
   */
  async flushSpend(): Promise<void> {
    const store = this.config.spendPersistence?.store
    if (store === undefined) return
    await store.save(this.tracker.allRecords())
  }

  /**
   * Fetch the latest model pricing and rate-limit caps from the configured PricingSource
   * and apply them to the ProviderRegistry.
   *
   * - New models are registered via `addModelPricing`.
   * - Existing models have their pricing updated in-place.
   * - Advisory `rpmLimit`/`tpmLimit` fields are currently logged but not enforced
   *   (wire them to a per-model RateLimiter to enforce).
   *
   * No-op when no `pricingRefresh` config is set.
   */
  async refreshPricing(): Promise<void> {
    const source = this.config.pricingRefresh?.source
    if (source === undefined) return

    let manifest
    try {
      manifest = await source.fetch()
    } catch (err) {
      process.stderr.write(`[FreeRouter] PricingSource fetch failed: ${String(err)}\n`)
      return
    }

    let updated = 0
    for (const [providerName, models] of Object.entries(manifest)) {
      for (const [modelId, entry] of Object.entries(models)) {
        const pricing: ModelPricingEntry = {
          input: entry.input,
          output: entry.output,
          ...(entry.cachedInput !== undefined && { cachedInput: entry.cachedInput }),
        }
        this.registry.addModelPricing(providerName, modelId, pricing)
        updated++
      }
    }

    this.config.onPricingRefreshed?.(updated)
  }

  /**
   * Re-fetch admin rules from the configured `rulesRefresh.source` and atomically
   * replace the in-memory rule set. No-op when no source is configured.
   */
  async refreshRules(): Promise<void> {
    const source = this.config.rulesRefresh?.source
    if (source === undefined || this.rulesEngine === undefined) return

    let rules: Rule[]
    try {
      rules = await source.fetch()
    } catch (err) {
      process.stderr.write(`[FreeRouter] RulesSource fetch failed: ${String(err)}\n`)
      return
    }

    this.rulesEngine.replaceRules(rules)
    this.config.onRulesRefreshed?.(rules.length)
  }

  /**
   * Add or replace a single admin rule at runtime.
   * Throws if the rules engine was not configured (no `rules` or `rulesRefresh`).
   */
  setRule(rule: Rule): void {
    if (this.rulesEngine === undefined) {
      throw new Error('[FreeRouter] Rules engine is not configured. Set `config.rules` or `config.rulesRefresh`.')
    }
    this.rulesEngine.upsertRule(rule)
  }

  /** Remove an admin rule by id. No-op if not configured or not found. */
  removeRule(id: string): void {
    this.rulesEngine?.removeRule(id)
  }

  /** Snapshot of the current admin rule list (for inspection). */
  listRules(): readonly Rule[] {
    return this.rulesEngine?.list() ?? []
  }

  /**
   * Graceful shutdown: flush spend records, clear all intervals, and remove
   * process signal listeners registered by this router instance.
   *
   * Always call this before process exit when using SpendStore persistence
   * to guarantee no spend data is lost.
   */
  async shutdown(): Promise<void> {
    if (this.spendFlushTimer !== undefined) {
      clearInterval(this.spendFlushTimer)
      this.spendFlushTimer = undefined
    }
    if (this.pricingRefreshTimer !== undefined) {
      clearInterval(this.pricingRefreshTimer)
      this.pricingRefreshTimer = undefined
    }
    if (this.rulesRefreshTimer !== undefined) {
      clearInterval(this.rulesRefreshTimer)
      this.rulesRefreshTimer = undefined
    }
    await this.flushSpend()
    for (const [signal, handler] of this.exitHandlers) {
      process.removeListener(signal, handler)
    }
    this.exitHandlers.clear()
  }

  private _registerExitHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      if (this.exitHandlers.has(signal)) continue
      const handler = () => {
        // Synchronously initiate shutdown; exit after flush completes
        void this.shutdown().finally(() => { process.exit(0) })
      }
      process.on(signal, handler)
      this.exitHandlers.set(signal, handler)
    }
  }

  // ── Key management ────────────────────────────────────────────────

  setKey(userId: string, provider: string, key: string, context?: RequestContext): void {
    this.keyManager.setKey(userId, provider, key)
    this.audit.keySet(userId, provider, context)
  }

  rotateKey(userId: string, provider: string, newKey: string, context?: RequestContext): void {
    this.keyManager.rotateKey(userId, provider, newKey)
    this.audit.keyRotated(userId, provider, context)
  }

  deleteKey(userId: string, provider: string): void {
    this.keyManager.deleteKey(userId, provider)
    this.audit.keyDeleted(userId, provider)
  }

  // ── Hot-reload: Providers ─────────────────────────────────────────

  /**
   * Subscribe to router lifecycle events.
   * Returns an unsubscribe function.
   */
  on<K extends keyof RouterEventMap>(
    event: K,
    handler: (payload: RouterEventMap[K]) => void,
  ): () => void {
    return this.events.on(event, handler)
  }

  /**
   * Register a new provider (or re-enable a previously removed one) at runtime.
   * Existing spend records and keys are unaffected.
   */
  async addProvider(
    name: string,
    factory: () => BaseProvider,
    prefixes: string[] = [],
    pricingMap?: Record<string, ModelPricingEntry>,
  ): Promise<void> {
    const key = name.toLowerCase()
    this.runtimeBlocked.delete(key)
    this.registry.registerFactory(key, factory, prefixes)
    this.allKnownProviders.add(key)
    if (pricingMap !== undefined) {
      for (const [modelId, pricing] of Object.entries(pricingMap)) {
        this.registry.addModelPricing(key, modelId, pricing)
      }
    }
    this.audit.providerAdded(key)
    this.events.emit('provider:added', { providerName: key, timestamp: Date.now() })
  }

  /**
   * Remove a provider at runtime.
   * By default, drains all in-flight requests for that provider before removing.
   * Pass { force: true } to skip draining.
   *
   * Spend records, keys, and FinOps state are never deleted.
   */
  async removeProvider(name: string, opts: { force?: boolean } = {}): Promise<void> {
    const key = name.toLowerCase()
    if (!opts.force) {
      const pending = this.inflight.get(key)
      if (pending !== undefined && pending.size > 0) {
        await Promise.allSettled([...pending])
      }
    }
    this.runtimeBlocked.add(key)
    this.registry.unregister(key)
    this.audit.providerRemoved(key)
    this.events.emit('provider:removed', { providerName: key, timestamp: Date.now() })
  }

  // ── Hot-reload: Models ────────────────────────────────────────────

  /** Register a new model (and pricing) on an existing provider at runtime. */
  addModel(providerName: string, modelId: string, pricing: ModelPricingEntry): void {
    const key = providerName.toLowerCase()
    this.registry.addModelPricing(key, modelId, pricing)
    this.audit.modelAdded(key, modelId)
    this.events.emit('model:added', { providerName: key, modelId, timestamp: Date.now() })
  }

  /**
   * Disallow routing to a model at runtime and remove its pricing entry.
   * Future requests for this model throw. Historical spend records remain.
   */
  removeModel(providerName: string, modelId: string): void {
    const key = providerName.toLowerCase()
    this.registry.removeModelPricing(key, modelId)
    this.audit.modelRemoved(key, modelId)
    this.events.emit('model:removed', { providerName: key, modelId, timestamp: Date.now() })
  }

  /**
   * Admin-level model block: prevents routing to a model without removing its
   * pricing history. Reversible via `unblockModel`.
   *
   * Useful for compliance holds, deprecation notices, or temporary capacity limits.
   */
  blockModel(providerName: string, modelId: string): void {
    this.registry.blockModel(providerName, modelId)
    this.audit.modelRemoved(providerName.toLowerCase(), modelId)
  }

  /** Re-allow routing to a model that was blocked via `blockModel`. */
  unblockModel(providerName: string, modelId: string): void {
    this.registry.unblockModel(providerName, modelId)
    this.audit.modelAdded(providerName.toLowerCase(), modelId)
  }

  /**
   * Override pricing for a specific model at runtime.
   * Accepts manual entry or a file path to a `PricingManifest` JSON.
   *
   * @example Manual override
   * router.setPricingOverride('openai', 'gpt-4o', { input: 2.50, output: 10.0, cachedInput: 1.25 })
   *
   * @example File-based override (async)
   * await router.setPricingOverrideFromFile('./config/pricing.json')
   */
  setPricingOverride(providerName: string, modelId: string, pricing: ModelPricingEntry): void {
    this.registry.addModelPricing(providerName.toLowerCase(), modelId, pricing)
  }

  // ── Chat (non-streaming) ──────────────────────────────────────────

  async chat(userId: string, req: ChatRequest, context: RequestContext = {}): Promise<ChatResponse> {
    this.validator.validate(req)

    // ── Admin rules: value-based overrides over pure cost optimization ──
    const ruleDecision = this.rulesEngine?.evaluate(userId, req, context) ?? { kind: 'noop' as const }
    if (ruleDecision.kind === 'block') {
      this.audit.requestBlocked({
        userId,
        model: req.model,
        reason: `Rule "${ruleDecision.ruleId}": ${ruleDecision.reason}`,
        ruleId: ruleDecision.ruleId,
        ...(context.teamId !== undefined && { teamId: context.teamId }),
        ...(context.orgId !== undefined && { orgId: context.orgId }),
      })
      this.metricsCollector.recordRequest('unknown', 0, 0, 'blocked')
      throw new Error(`[FreeRouter] Request blocked by rule "${ruleDecision.ruleId}": ${ruleDecision.reason}`)
    }

    // ── Cost optimization (mediated by rule mode) ──
    const optimizedModel = this.applyRuleAndCost(req, ruleDecision)
    const effectiveReq: ChatRequest = optimizedModel !== req.model
      ? { ...req, model: optimizedModel }
      : req

    const decision = this.policyEngine.evaluate(userId, effectiveReq, context)
    if (!decision.allowed) {
      this.audit.requestBlocked({
        userId,
        model: req.model,
        reason: decision.blockedReason ?? 'Policy blocked',
        ...(decision.policyId !== undefined && { policyId: decision.policyId }),
        ...(ruleDecision.kind !== 'noop' && { ruleId: ruleDecision.ruleId }),
        ...(context.teamId !== undefined && { teamId: context.teamId }),
        ...(context.orgId !== undefined && { orgId: context.orgId }),
      })
      this.metricsCollector.recordRequest('unknown', 0, 0, 'blocked')
      throw new Error(`[FreeRouter] Request blocked: ${decision.blockedReason}`)
    }

    const finalReq: ChatRequest = { ...effectiveReq, model: decision.effectiveModel }
    const { provider, modelName } = this.registry.resolveFromModel(
      decision.effectiveModel,
      this.config.defaultProvider,
    )

    if (this.runtimeBlocked.has(provider.name.toLowerCase())) {
      throw new Error(`[FreeRouter] Provider "${provider.name}" has been removed.`)
    }

    const hmacKey = this.keyManager.deriveHmacKey(userId)
    const { contentHash } = this.signer.sign({ signingKey: hmacKey, userId, model: modelName, messages: req.messages })

    const start = Date.now()
    let response!: ChatResponse
    const providerKey = provider.name.toLowerCase()

    const requestPromise = this.keyManager.withKey(userId, provider.name, async apiKey => {
      response = await provider.chat(finalReq, apiKey)
    })

    this.trackInflight(providerKey, requestPromise)
    try {
      await requestPromise
      this.metricsCollector.recordRequest(providerKey, Date.now() - start, 0, 'success')
    } catch (err) {
      this.metricsCollector.recordRequest(providerKey, Date.now() - start, 0, 'failure')
      throw err
    } finally {
      this.untrackInflight(providerKey, requestPromise)
    }

    const record = this.buildRecord(userId, provider.name, modelName, response, context)
    this.metricsCollector.recordRequest(providerKey, response.latencyMs, record.costUsd, 'success')
    this.tracker.recordSpend(record)
    this.config.onRequestComplete?.(record)

    this.audit.requestSent({
      userId,
      provider: provider.name,
      model: modelName,
      costUsd: record.costUsd,
      ...(contentHash !== '' && { requestHash: contentHash }),
      ...(context.teamId !== undefined && { teamId: context.teamId }),
      ...(context.departmentId !== undefined && { departmentId: context.departmentId }),
      ...(context.orgId !== undefined && { orgId: context.orgId }),
      ...(decision.policyId !== undefined && { policyId: decision.policyId }),
      ...(ruleDecision.kind !== 'noop' && { ruleId: ruleDecision.ruleId }),
    })

    this.rateLimiter?.consume(context.teamId ?? userId, response.usage.totalTokens)
    this.tracker.prune()
    this.rateLimiter?.prune()

    return response
  }

  // ── Chat (streaming) ──────────────────────────────────────────────

  async *chatStream(userId: string, req: ChatRequest, context: RequestContext = {}): AsyncGenerator<StreamChunk> {
    this.validator.validate(req)

    // ── Admin rules ──
    const ruleDecision = this.rulesEngine?.evaluate(userId, req, context) ?? { kind: 'noop' as const }
    if (ruleDecision.kind === 'block') {
      this.audit.requestBlocked({
        userId,
        model: req.model,
        reason: `Rule "${ruleDecision.ruleId}": ${ruleDecision.reason}`,
        ruleId: ruleDecision.ruleId,
        ...(context.teamId !== undefined && { teamId: context.teamId }),
        ...(context.orgId !== undefined && { orgId: context.orgId }),
      })
      this.metricsCollector.recordRequest('unknown', 0, 0, 'blocked')
      throw new Error(`[FreeRouter] Request blocked by rule "${ruleDecision.ruleId}": ${ruleDecision.reason}`)
    }

    // ── Cost optimization (mediated by rule mode) ──
    const optimizedModel = this.applyRuleAndCost(req, ruleDecision)
    const effectiveReq: ChatRequest = optimizedModel !== req.model
      ? { ...req, model: optimizedModel }
      : req

    const decision = this.policyEngine.evaluate(userId, effectiveReq, context)
    if (!decision.allowed) {
      this.audit.requestBlocked({
        userId,
        model: req.model,
        reason: decision.blockedReason ?? 'Policy blocked',
        ...(decision.policyId !== undefined && { policyId: decision.policyId }),
        ...(ruleDecision.kind !== 'noop' && { ruleId: ruleDecision.ruleId }),
        ...(context.teamId !== undefined && { teamId: context.teamId }),
        ...(context.orgId !== undefined && { orgId: context.orgId }),
      })
      this.metricsCollector.recordRequest('unknown', 0, 0, 'blocked')
      throw new Error(`[FreeRouter] Request blocked: ${decision.blockedReason}`)
    }

    const finalReq: ChatRequest = { ...effectiveReq, model: decision.effectiveModel }
    const { provider, modelName } = this.registry.resolveFromModel(
      decision.effectiveModel,
      this.config.defaultProvider,
    )

    if (this.runtimeBlocked.has(provider.name.toLowerCase())) {
      throw new Error(`[FreeRouter] Provider "${provider.name}" has been removed.`)
    }

    const hmacKey = this.keyManager.deriveHmacKey(userId)
    const { contentHash } = this.signer.sign({ signingKey: hmacKey, userId, model: modelName, messages: req.messages })

    const start = Date.now()
    const providerKey = provider.name.toLowerCase()

    // Collect chunks inside callback (yield cannot cross async callback boundary)
    const chunks: StreamChunk[] = []
    const requestPromise = this.keyManager.withKey(userId, provider.name, async apiKey => {
      for await (const chunk of provider.chatStream(finalReq, apiKey)) {
        chunks.push(chunk)
      }
    })

    this.trackInflight(providerKey, requestPromise)
    try {
      await requestPromise
      this.metricsCollector.recordRequest(providerKey, Date.now() - start, 0, 'success')
    } catch (err) {
      this.metricsCollector.recordRequest(providerKey, Date.now() - start, 0, 'failure')
      throw err
    } finally {
      this.untrackInflight(providerKey, requestPromise)
    }

    let finalChunk: StreamChunk | undefined
    for (const chunk of chunks) {
      yield chunk
      if (chunk.done) finalChunk = chunk
    }

    if (finalChunk?.usage !== undefined) {
      const record = this.buildStreamRecord(userId, provider.name, modelName, finalChunk, context)
      this.tracker.recordSpend(record)
      this.config.onRequestComplete?.(record)
      this.audit.requestSent({
        userId,
        provider: provider.name,
        model: modelName,
        costUsd: record.costUsd,
        ...(contentHash !== '' && { requestHash: contentHash }),
        ...(context.teamId !== undefined && { teamId: context.teamId }),
        ...(context.departmentId !== undefined && { departmentId: context.departmentId }),
        ...(context.orgId !== undefined && { orgId: context.orgId }),
        ...(ruleDecision.kind !== 'noop' && { ruleId: ruleDecision.ruleId }),
      })
      this.rateLimiter?.consume(context.teamId ?? userId, finalChunk.usage.totalTokens)
    }

    this.tracker.prune()
    this.rateLimiter?.prune()
  }

  // ── FinOps API ────────────────────────────────────────────────────

  addBudgetPolicy(policy: BudgetPolicy): void { this.policies.push(policy) }

  getSpend(scope: BudgetScope, window: BudgetWindow): SpendSummary {
    return this.tracker.getSpend(scope, window)
  }

  getForecast(scope: BudgetScope, window: BudgetWindow, budgetUsd: number): SpendForecast {
    return this.forecaster.forecast(scope, window, budgetUsd)
  }

  getChargebackReport(scope: BudgetScope, start: Date, end: Date): ChargebackReport {
    return this.chargeback.generateReport(scope, start, end)
  }

  // ── Extension ─────────────────────────────────────────────────────

  registerProvider(provider: BaseProvider): void { this.registry.register(provider) }

  listProviders(): string[] { return this.registry.list() }

  /**
   * Install a plugin. Duplicate installs (by name) are silently skipped.
   * Returns `this` for chaining.
   */
  use(plugin: FreeRouterPlugin): this {
    if (this.installedPlugins.has(plugin.name)) {
      process.stderr.write(`[FreeRouter] Plugin "${plugin.name}" already installed — skipping.\n`)
      return this
    }
    plugin.install(this)
    this.installedPlugins.add(plugin.name)
    return this
  }

  // ── Health & Metrics ──────────────────────────────────────────────

  healthCheck(): HealthStatus {
    // Combine active providers and known-but-removed providers for full picture
    const activeNames = new Set(this.registry.list().map(n => n.toLowerCase()))
    const allNames = new Set([...activeNames, ...this.allKnownProviders])
    const providers: ProviderHealth[] = [...allNames].map(name => ({
      name,
      available: activeNames.has(name) && !this.runtimeBlocked.has(name),
    }))

    const available = providers.filter(p => p.available).length
    let status: HealthStatus['status']
    if (available === 0) status = 'unhealthy'
    else if (available < providers.length) status = 'degraded'
    else status = 'healthy'

    return {
      status,
      providers,
      uptime: Date.now() - this.startTime,
      timestamp: Date.now(),
    }
  }

  metrics(): RouterMetrics {
    return this.metricsCollector.snapshot()
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Combine the admin rule decision with the cost router according to the
   * configured `RulesMode`. Pure computation — no I/O.
   */
  private applyRuleAndCost(req: ChatRequest, ruleDecision: RuleDecision): string {
    const tokens = estimatePromptTokens(req.messages)
    const isRealtime = req.priority === 'realtime'
    const mode = this.rulesEngine?.mode ?? 'pin-wins'

    // No rule matched — fall through to standard cost optimization.
    if (ruleDecision.kind === 'noop') {
      if (this.costRouter === undefined) return req.model
      return this.costRouter.selectModel(req.model, tokens, isRealtime)
    }

    if (ruleDecision.kind === 'pin') {
      if (mode === 'pin-wins') return ruleDecision.model
      if (mode === 'narrow-candidates') {
        // Cost router still runs but the candidate pool is just the pinned model.
        if (this.costRouter === undefined) return ruleDecision.model
        return this.costRouter.selectModel(req.model, tokens, isRealtime, {
          candidateModels: [ruleDecision.model],
        })
      }
      // post-override: cost router runs (for pricing accounting), then pin wins.
      return ruleDecision.model
    }

    if (ruleDecision.kind === 'strategy') {
      if (this.costRouter === undefined) return req.model
      return this.costRouter.selectModel(req.model, tokens, isRealtime, {
        strategy: ruleDecision.strategy,
        ...(ruleDecision.candidateModels !== undefined && { candidateModels: ruleDecision.candidateModels }),
      })
    }

    // 'block' decisions are handled upstream before reaching this helper.
    return req.model
  }

  private trackInflight(providerKey: string, promise: Promise<unknown>): void {
    let set = this.inflight.get(providerKey)
    if (set === undefined) {
      set = new Set()
      this.inflight.set(providerKey, set)
    }
    set.add(promise)
  }

  private untrackInflight(providerKey: string, promise: Promise<unknown>): void {
    this.inflight.get(providerKey)?.delete(promise)
  }

  private buildRecord(
    userId: string,
    providerName: string,
    modelName: string,
    response: ChatResponse,
    context: RequestContext,
  ): SpendRecord {
    const pricing = this.registry.getModelPricing(providerName, modelName)
      ?? this.registry.resolveFromModel(`${providerName}/${modelName}`, providerName).provider.pricing(modelName)
    const costUsd = calculateCost(response.usage, pricing)
    return {
      userId,
      ...(context.orgId !== undefined && { orgId: context.orgId }),
      ...(context.departmentId !== undefined && { departmentId: context.departmentId }),
      ...(context.teamId !== undefined && { teamId: context.teamId }),
      provider: providerName,
      model: modelName,
      tokens: response.usage,
      costUsd,
      timestamp: Date.now(),
      ...(response.usage.cachedPromptTokens !== undefined && {
        cachedPromptTokens: response.usage.cachedPromptTokens,
      }),
    }
  }

  private buildStreamRecord(
    userId: string,
    providerName: string,
    modelName: string,
    finalChunk: StreamChunk,
    context: RequestContext,
  ): SpendRecord {
    const usage = finalChunk.usage!
    const pricing = this.registry.getModelPricing(providerName, modelName)
      ?? this.registry.resolveFromModel(`${providerName}/${modelName}`, providerName).provider.pricing(modelName)
    const costUsd = calculateCost(usage, pricing)
    return {
      userId,
      ...(context.orgId !== undefined && { orgId: context.orgId }),
      ...(context.departmentId !== undefined && { departmentId: context.departmentId }),
      ...(context.teamId !== undefined && { teamId: context.teamId }),
      provider: providerName,
      model: modelName,
      tokens: usage,
      costUsd,
      timestamp: Date.now(),
      ...(usage.cachedPromptTokens !== undefined && {
        cachedPromptTokens: usage.cachedPromptTokens,
      }),
    }
  }
}
