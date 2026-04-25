import type { ChatRequest, ChatResponse, StreamChunk, TokenUsage } from '../types.js'
import { BaseProvider, type ProviderPricing } from './base-provider.js'

// Groq uses an OpenAI-compatible API
const API_BASE = 'https://api.groq.com/openai/v1'

const PRICING: Record<string, ProviderPricing> = {
  'llama-3.3-70b-versatile':   { input: 0.59, output: 0.79 },
  'llama-3.1-70b-versatile':   { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':      { input: 0.05, output: 0.08 },
  'llama3-70b-8192':           { input: 0.59, output: 0.79 },
  'llama3-8b-8192':            { input: 0.05, output: 0.08 },
  'mixtral-8x7b-32768':        { input: 0.24, output: 0.24 },
  'gemma2-9b-it':              { input: 0.20, output: 0.20 },
}

const DEFAULT_PRICING: ProviderPricing = { input: 0.59, output: 0.79 }

interface GroqResponse {
  id: string
  choices: Array<{ message: { content: string }; finish_reason: string }>
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

interface GroqStreamChunk {
  id: string
  choices: Array<{ delta: { content?: string }; finish_reason: string | null }>
  x_groq?: { usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
}

export class GroqProvider extends BaseProvider {
  readonly name = 'groq'

  pricing(model: string): ProviderPricing {
    const key = Object.keys(PRICING).find(k => model.startsWith(k))
    return key !== undefined ? (PRICING[key] ?? DEFAULT_PRICING) : DEFAULT_PRICING
  }

  async chat(req: ChatRequest, apiKey: string): Promise<ChatResponse> {
    const start = Date.now()
    const model = req.model.replace(/^groq\//, '')

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
    const data = (await resp.json()) as GroqResponse
    const choice = data.choices[0]
    if (choice === undefined) throw new Error('[FreeRouter/groq] No choices returned')

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
    const model = req.model.replace(/^groq\//, '')

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
    if (resp.body === null) throw new Error('[FreeRouter/groq] Empty stream body')

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
          const chunk = JSON.parse(json) as GroqStreamChunk
          const choice = chunk.choices[0]
          const delta = choice?.delta.content ?? ''
          const isDone = choice?.finish_reason !== null && choice?.finish_reason !== undefined
          if (chunk.x_groq?.usage) {
            finalUsage = {
              promptTokens: chunk.x_groq.usage.prompt_tokens,
              completionTokens: chunk.x_groq.usage.completion_tokens,
              totalTokens: chunk.x_groq.usage.total_tokens,
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
