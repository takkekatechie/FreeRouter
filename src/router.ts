import type {
  BudgetPolicy,
  BudgetScope,
  BudgetWindow,
  ChargebackReport,
  ChatRequest,
  ChatResponse,
  RequestContext,
  SpendForecast,
  SpendRecord,
  SpendSummary,
  StreamChunk,
} from './types.js'
import type { RouterConfig } from './config.js'
import type { BaseProvider } from './providers/base-provider.js'
import { ProviderRegistry } from './providers/registry.js'
import { KeyManager } from './security/key-manager.js'
import { AuditLogger } from './security/audit-logger.js'
import { RequestSigner } from './security/request-signer.js'
import { InputValidator } from './security/input-validator.js'
import { SpendTracker } from './finops/spend-tracker.js'
import { SpendForecaster } from './finops/spend-forecaster.js'
import { ChargebackEngine } from './finops/chargeback.js'
import { RateLimiter } from './finops/rate-limiter.js'
import { PolicyEngine } from './finops/policy-engine.js'
import { calculateCost } from './finops/cost-calculator.js'
import { loadConfigFile, loadConfigFromEnv, mergeConfigs, validateConfigKeys } from './config-loader.js'

export class FreeRouter {
  private readonly registry: ProviderRegistry
  private readonly keyManager: KeyManager
  private readonly audit: AuditLogger
  private readonly signer: RequestSigner
  private readonly validator: InputValidator
  private readonly tracker: SpendTracker
  private readonly forecaster: SpendForecaster
  private readonly chargeback: ChargebackEngine
  private readonly rateLimiter: RateLimiter | undefined
  private readonly policyEngine: PolicyEngine
  private readonly config: RouterConfig
  private readonly policies: BudgetPolicy[]

  // ── Static factory methods ────────────────────────────────

  /**
   * Create a router from a JSON/YAML/TOML config file.
   * Format is auto-detected from file extension.
   */
  static async fromFile(filePath: string, overrides?: Partial<RouterConfig>): Promise<FreeRouter> {
    const fileConfig = await loadConfigFile(filePath)
    const unknownKeys = validateConfigKeys(fileConfig as Record<string, unknown>)
    if (unknownKeys.length > 0) {
      process.stderr.write(`[FreeRouter] Warning: unknown config keys: ${unknownKeys.join(', ')}\n`)
    }
    const merged = mergeConfigs(fileConfig, overrides) as RouterConfig
    return new FreeRouter(merged)
  }

  /**
   * Create a router from the path in FREEROUTER_CONFIG env var.
   */
  static async fromEnv(overrides?: Partial<RouterConfig>): Promise<FreeRouter> {
    const fileConfig = await loadConfigFromEnv()
    const merged = mergeConfigs(fileConfig, overrides) as RouterConfig
    return new FreeRouter(merged)
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
  }

  // ── Key management ────────────────────────────────────────────

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

  // ── Chat (non-streaming) ──────────────────────────────────────

  async chat(userId: string, req: ChatRequest, context: RequestContext = {}): Promise<ChatResponse> {
    this.validator.validate(req)

    const decision = this.policyEngine.evaluate(userId, req, context)
    if (!decision.allowed) {
      this.audit.requestBlocked({
        userId,
        model: req.model,
        reason: decision.blockedReason ?? 'Policy blocked',
        ...(decision.policyId !== undefined && { policyId: decision.policyId }),
        ...(context.teamId !== undefined && { teamId: context.teamId }),
        ...(context.orgId !== undefined && { orgId: context.orgId }),
      })
      throw new Error(`[FreeRouter] Request blocked: ${decision.blockedReason}`)
    }

    const effectiveReq: ChatRequest = { ...req, model: decision.effectiveModel }
    const { provider, modelName } = this.registry.resolveFromModel(
      decision.effectiveModel,
      this.config.defaultProvider,
    )

    const hmacKey = this.keyManager.deriveHmacKey(userId)
    const { contentHash } = this.signer.sign({ signingKey: hmacKey, userId, model: modelName, messages: req.messages })

    let response!: ChatResponse
    await this.keyManager.withKey(userId, provider.name, async apiKey => {
      response = await provider.chat(effectiveReq, apiKey)
    })

    const record = this.buildRecord(userId, provider.name, modelName, response, context)
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
    })

    this.rateLimiter?.consume(context.teamId ?? userId, response.usage.totalTokens)
    this.tracker.prune()
    this.rateLimiter?.prune()

    return response
  }

  // ── Chat (streaming) ──────────────────────────────────────────

  async *chatStream(userId: string, req: ChatRequest, context: RequestContext = {}): AsyncGenerator<StreamChunk> {
    this.validator.validate(req)

    const decision = this.policyEngine.evaluate(userId, req, context)
    if (!decision.allowed) {
      this.audit.requestBlocked({
        userId,
        model: req.model,
        reason: decision.blockedReason ?? 'Policy blocked',
        ...(decision.policyId !== undefined && { policyId: decision.policyId }),
        ...(context.teamId !== undefined && { teamId: context.teamId }),
        ...(context.orgId !== undefined && { orgId: context.orgId }),
      })
      throw new Error(`[FreeRouter] Request blocked: ${decision.blockedReason}`)
    }

    const effectiveReq: ChatRequest = { ...req, model: decision.effectiveModel }
    const { provider, modelName } = this.registry.resolveFromModel(
      decision.effectiveModel,
      this.config.defaultProvider,
    )

    const hmacKey = this.keyManager.deriveHmacKey(userId)
    const { contentHash } = this.signer.sign({ signingKey: hmacKey, userId, model: modelName, messages: req.messages })

    // Collect chunks inside callback (yield cannot cross async callback boundary)
    const chunks: StreamChunk[] = []
    await this.keyManager.withKey(userId, provider.name, async apiKey => {
      for await (const chunk of provider.chatStream(effectiveReq, apiKey)) {
        chunks.push(chunk)
      }
    })

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
      })
      this.rateLimiter?.consume(context.teamId ?? userId, finalChunk.usage.totalTokens)
    }

    this.tracker.prune()
    this.rateLimiter?.prune()
  }

  // ── FinOps API ────────────────────────────────────────────────

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

  // ── Extension ─────────────────────────────────────────────────

  registerProvider(provider: BaseProvider): void { this.registry.register(provider) }

  listProviders(): string[] { return this.registry.list() }

  // ── Private helpers ───────────────────────────────────────────

  private buildRecord(
    userId: string,
    providerName: string,
    modelName: string,
    response: ChatResponse,
    context: RequestContext,
  ): SpendRecord {
    const { provider } = this.registry.resolveFromModel(`${providerName}/${modelName}`, providerName)
    const costUsd = calculateCost(response.usage, provider.pricing(modelName))
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
    const { provider } = this.registry.resolveFromModel(`${providerName}/${modelName}`, providerName)
    const costUsd = calculateCost(usage, provider.pricing(modelName))
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
    }
  }
}
