import type { ChatRequest, ChatResponse, StreamChunk, TokenUsage } from '../types.js'
import { BaseProvider, type ProviderPricing } from './base-provider.js'

const API_BASE = 'https://api.openai.com/v1'

const PRICING: Record<string, ProviderPricing> = {
  'gpt-4o':                { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':           { input: 0.15,  output: 0.60  },
  'o3':                    { input: 10.00, output: 40.00 },
  'o3-mini':               { input: 1.10,  output: 4.40  },
  'o4-mini':               { input: 1.10,  output: 4.40  },
  'gpt-4-turbo':           { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo':         { input: 0.50,  output: 1.50  },
}

const DEFAULT_PRICING: ProviderPricing = { input: 5.00, output: 15.00 }

interface OAIMessage {
  role: string
  content: string
}

interface OAIResponse {
  id: string
  choices: Array<{
    message: { content: string }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface OAIStreamChunk {
  id: string
  choices: Array<{
    delta: { content?: string }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai'

  pricing(model: string): ProviderPricing {
    const key = Object.keys(PRICING).find(k => model.startsWith(k))
    return key !== undefined ? (PRICING[key] ?? DEFAULT_PRICING) : DEFAULT_PRICING
  }

  private toOAIMessages(req: ChatRequest): OAIMessage[] {
    return req.messages.map(m => ({ role: m.role, content: m.content }))
  }

  async chat(req: ChatRequest, apiKey: string): Promise<ChatResponse> {
    const start = Date.now()
    const model = req.model.replace(/^openai\//, '')

    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: this.toOAIMessages(req),
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
      }),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)

    const data = (await resp.json()) as OAIResponse
    const choice = data.choices[0]
    if (choice === undefined) throw new Error('[FreeRouter/openai] No choices returned')

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
    const model = req.model.replace(/^openai\//, '')

    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: this.toOAIMessages(req),
        stream: true,
        stream_options: { include_usage: true },
        ...(req.temperature !== undefined && { temperature: req.temperature }),
        ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
      }),
    })

    if (!resp.ok) await this.throwHttpError(resp, this.name)
    if (resp.body === null) throw new Error('[FreeRouter/openai] Empty stream body')

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
          const chunk = JSON.parse(json) as OAIStreamChunk
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
        } catch {
          // malformed chunk — skip
        }
      }
    }

    yield { delta: '', done: true, ...(finalUsage ? { usage: finalUsage } : {}) }
  }
}
