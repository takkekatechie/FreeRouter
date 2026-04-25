import type { ChatRequest, ChatResponse, StreamChunk, TokenUsage } from '../types.js'
import { BaseProvider, type ProviderPricing } from './base-provider.js'

// Mistral uses an OpenAI-compatible API
const API_BASE = 'https://api.mistral.ai/v1'

const PRICING: Record<string, ProviderPricing> = {
  'mistral-large':        { input: 2.00, output: 6.00  },
  'mistral-medium':       { input: 0.40, output: 2.00  },
  'mistral-small':        { input: 0.10, output: 0.30  },
  'mistral-7b':           { input: 0.025, output: 0.025 },
  'mixtral-8x7b':         { input: 0.70, output: 0.70  },
  'mixtral-8x22b':        { input: 2.00, output: 6.00  },
  'codestral':            { input: 0.20, output: 0.60  },
}

const DEFAULT_PRICING: ProviderPricing = { input: 2.00, output: 6.00 }

interface MistralResponse {
  id: string
  choices: Array<{ message: { content: string }; finish_reason: string }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

interface MistralStreamChunk {
  id: string
  choices: Array<{ delta: { content?: string }; finish_reason: string | null }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export class MistralProvider extends BaseProvider {
  readonly name = 'mistral'

  pricing(model: string): ProviderPricing {
    const key = Object.keys(PRICING).find(k => model.startsWith(k))
    return key !== undefined ? (PRICING[key] ?? DEFAULT_PRICING) : DEFAULT_PRICING
  }

  async chat(req: ChatRequest, apiKey: string): Promise<ChatResponse> {
    const start = Date.now()
    const model = req.model.replace(/^mistral\//, '')

    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
      }),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)
    const data = (await resp.json()) as MistralResponse
    const choice = data.choices[0]
    if (choice === undefined) throw new Error('[FreeRouter/mistral] No choices returned')

    const usage: TokenUsage = {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    }
    return {
      id: data.id,
      model,
      content: choice.message.content,
      usage,
      latencyMs: this.elapsed(start),
      provider: this.name,
      finishedAt: Date.now(),
    }
  }

  async *chatStream(req: ChatRequest, apiKey: string): AsyncIterable<StreamChunk> {
    const model = req.model.replace(/^mistral\//, '')

    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: req.messages,
        stream: true,
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
      }),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)
    if (resp.body === null) throw new Error('[FreeRouter/mistral] Empty stream body')

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalUsage: TokenUsage | undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const json = line.slice(6).trim()
        if (json === '[DONE]') {
          yield { delta: '', done: true, ...(finalUsage ? { usage: finalUsage } : {}) }
          return
        }
        try {
          const chunk = JSON.parse(json) as MistralStreamChunk
          const choice = chunk.choices[0]
          const delta = choice?.delta.content ?? ''
          const isDone = choice?.finish_reason !== null && choice?.finish_reason !== undefined
          if (chunk.usage) {
            finalUsage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            }
          }
          if (delta !== '' || isDone) {
            yield { delta, done: isDone, ...(isDone && finalUsage ? { usage: finalUsage } : {}) }
          }
        } catch { /* skip */ }
      }
    }
    yield { delta: '', done: true, ...(finalUsage ? { usage: finalUsage } : {}) }
  }
}
