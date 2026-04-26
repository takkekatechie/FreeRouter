import type { BaseProvider } from './base-provider.js'
import type { ProviderToggle } from '../config.js'
import type { ModelPricingEntry } from '../types.js'
import { GoogleProvider } from './google.js'
import { OpenAIProvider } from './openai.js'
import { AnthropicProvider } from './anthropic.js'
import { MistralProvider } from './mistral.js'
import { GroqProvider } from './groq.js'

type ProviderFactory = () => BaseProvider

/**
 * Default model-prefix → provider routing.
 * Can be overridden per-provider via config.providers[name].routingPrefixes.
 */
const DEFAULT_PREFIX_MAP: Record<string, string[]> = {
  'google':    ['gemini'],
  'openai':    ['gpt', 'o3', 'o4'],
  'anthropic': ['claude'],
  'mistral':   ['mistral', 'mixtral', 'codestral'],
  'groq':      ['llama', 'gemma'],
}

/** Built-in provider factories — providers are only instantiated when first used */
const BUILT_IN_FACTORIES: Record<string, ProviderFactory> = {
  'google':    () => new GoogleProvider(),
  'openai':    () => new OpenAIProvider(),
  'anthropic': () => new AnthropicProvider(),
  'mistral':   () => new MistralProvider(),
  'groq':      () => new GroqProvider(),
}

export class ProviderRegistry {
  private readonly providers = new Map<string, BaseProvider>()
  private readonly factories = new Map<string, ProviderFactory>()
  private readonly blocked: Set<string>
  private readonly prefixMap = new Map<string, string>() // prefix → providerName
  private readonly disallowedModels = new Map<string, Set<string>>() // providerName → Set<modelId>
  private readonly runtimePricing = new Map<string, Map<string, ModelPricingEntry>>() // providerName → modelId → pricing

  constructor(
    blockedProviders: string[] = [],
    providerConfig?: Record<string, ProviderToggle>,
  ) {
    this.blocked = new Set(blockedProviders.map(p => p.toLowerCase()))

    // Register built-in provider factories (lazy — no instantiation yet)
    for (const [name, factory] of Object.entries(BUILT_IN_FACTORIES)) {
      if (this.blocked.has(name)) continue

      // Check per-provider toggle
      const toggle = providerConfig?.[name]
      if (toggle?.enabled === false) continue

      this.factories.set(name, factory)

      // Build prefix map — custom prefixes override defaults
      const prefixes = toggle?.routingPrefixes ?? DEFAULT_PREFIX_MAP[name] ?? []
      for (const prefix of prefixes) {
        this.prefixMap.set(prefix.toLowerCase(), name)
      }
    }
  }

  /** Register a custom provider (eager — instantiated immediately) */
  register(provider: BaseProvider): void {
    const name = provider.name.toLowerCase()
    if (this.blocked.has(name)) {
      throw new Error(
        `[FreeRouter] Provider "${name}" is blocked by policy and cannot be registered.`,
      )
    }
    this.providers.set(name, provider)
  }

  /** Register a lazy factory for a custom provider */
  registerFactory(name: string, factory: ProviderFactory, prefixes: string[] = []): void {
    const key = name.toLowerCase()
    if (this.blocked.has(key)) {
      throw new Error(
        `[FreeRouter] Provider "${key}" is blocked by policy and cannot be registered.`,
      )
    }
    this.factories.set(key, factory)
    for (const p of prefixes) {
      this.prefixMap.set(p.toLowerCase(), key)
    }
  }

  /**
   * Remove a provider and all its prefix mappings from the registry.
   * Historical spend records and key manager entries are unaffected.
   */
  unregister(name: string): void {
    const key = name.toLowerCase()
    this.providers.delete(key)
    this.factories.delete(key)
    // Remove prefix entries pointing to this provider
    for (const [prefix, providerName] of this.prefixMap) {
      if (providerName === key) this.prefixMap.delete(prefix)
    }
  }

  /** Register or update a model-level pricing override for a provider */
  addModelPricing(providerName: string, modelId: string, pricing: ModelPricingEntry): void {
    const key = providerName.toLowerCase()
    let modelMap = this.runtimePricing.get(key)
    if (modelMap === undefined) {
      modelMap = new Map()
      this.runtimePricing.set(key, modelMap)
    }
    modelMap.set(modelId.toLowerCase(), pricing)
    // Remove from disallowed if re-adding a previously removed model
    this.disallowedModels.get(key)?.delete(modelId.toLowerCase())
  }

  /**
   * Disallow routing to a specific model and remove its runtime pricing entry.
   * Existing spend records are unaffected; future requests for this model throw.
   */
  removeModelPricing(providerName: string, modelId: string): void {
    const key = providerName.toLowerCase()
    const modelLower = modelId.toLowerCase()
    this.runtimePricing.get(key)?.delete(modelLower)
    this._disallow(key, modelLower)
  }

  /**
   * Block routing to a model without removing its pricing entry.
   * Use this for admin-level access control — pricing history is preserved for
   * reporting and can be restored with `unblockModel`.
   */
  blockModel(providerName: string, modelId: string): void {
    this._disallow(providerName.toLowerCase(), modelId.toLowerCase())
  }

  /**
   * Re-allow routing to a previously blocked model.
   * Does NOT re-add the model if its pricing entry was removed via `removeModelPricing`.
   */
  unblockModel(providerName: string, modelId: string): void {
    this.disallowedModels.get(providerName.toLowerCase())?.delete(modelId.toLowerCase())
  }

  private _disallow(providerKey: string, modelLower: string): void {
    let disallowed = this.disallowedModels.get(providerKey)
    if (disallowed === undefined) {
      disallowed = new Set()
      this.disallowedModels.set(providerKey, disallowed)
    }
    disallowed.add(modelLower)
  }

  /** Check if a model is still allowed for routing */
  isModelAllowed(providerName: string, modelId: string): boolean {
    return !(this.disallowedModels.get(providerName.toLowerCase())?.has(modelId.toLowerCase()) ?? false)
  }

  /** Get runtime pricing override for a model (if registered via addModelPricing) */
  getModelPricing(providerName: string, modelId: string): ModelPricingEntry | undefined {
    return this.runtimePricing.get(providerName.toLowerCase())?.get(modelId.toLowerCase())
  }

  get(name: string): BaseProvider {
    const key = name.toLowerCase()

    // Already instantiated?
    const existing = this.providers.get(key)
    if (existing !== undefined) return existing

    // Lazy instantiation from factory
    const factory = this.factories.get(key)
    if (factory !== undefined) {
      const provider = factory()
      this.providers.set(key, provider)
      return provider
    }

    throw new Error(
      `[FreeRouter] Unknown provider: "${name}". Register it with router.registerProvider().`,
    )
  }

  /**
   * Resolve a provider from a raw model string.
   * 1. Explicit "provider/model" prefix
   * 2. Model-prefix heuristic via prefixMap
   * 3. Fall back to defaultProvider
   */
  resolveFromModel(model: string, defaultProvider?: string): { provider: BaseProvider; modelName: string } {
    // Explicit prefix: "google/gemini-2.0-flash"
    const slashIdx = model.indexOf('/')
    if (slashIdx > 0) {
      const providerName = model.slice(0, slashIdx)
      const modelName = model.slice(slashIdx + 1)
      const provider = this.get(providerName)
      if (!this.isModelAllowed(providerName, modelName)) {
        throw new Error(`[FreeRouter] Model "${modelName}" has been removed from provider "${providerName}".`)
      }
      return { provider, modelName }
    }

    // Heuristic prefix match
    const modelLower = model.toLowerCase()
    for (const [prefix, providerName] of this.prefixMap) {
      if (modelLower.startsWith(prefix)) {
        if (!this.isModelAllowed(providerName, model)) {
          throw new Error(`[FreeRouter] Model "${model}" has been removed from provider "${providerName}".`)
        }
        return { provider: this.get(providerName), modelName: model }
      }
    }

    // Fall back to configured default
    if (defaultProvider !== undefined) {
      if (!this.isModelAllowed(defaultProvider, model)) {
        throw new Error(`[FreeRouter] Model "${model}" has been removed from provider "${defaultProvider}".`)
      }
      return { provider: this.get(defaultProvider), modelName: model }
    }

    throw new Error(
      `[FreeRouter] Cannot determine provider for model "${model}". ` +
      'Use "provider/model" format or set defaultProvider in config.',
    )
  }

  /** List all registered + available (factory-registered) provider names */
  list(): string[] {
    const names = new Set([...this.providers.keys(), ...this.factories.keys()])
    return [...names]
  }

  /** Check if a provider is available (registered or has factory) */
  has(name: string): boolean {
    const key = name.toLowerCase()
    return this.providers.has(key) || this.factories.has(key)
  }
}
