import type { BaseProvider } from './base-provider.js'
import type { ProviderToggle } from '../config.js'
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
      return { provider: this.get(providerName), modelName }
    }

    // Heuristic prefix match
    const modelLower = model.toLowerCase()
    for (const [prefix, providerName] of this.prefixMap) {
      if (modelLower.startsWith(prefix)) {
        return { provider: this.get(providerName), modelName: model }
      }
    }

    // Fall back to configured default
    if (defaultProvider !== undefined) {
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
