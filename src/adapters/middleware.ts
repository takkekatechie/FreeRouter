import type { FreeRouter } from '../router.js'
import type { RequestContext } from '../types.js'

/**
 * Duck-typed minimal interfaces covering both Express and Fastify shapes.
 * We never import either framework — callers wire this up themselves.
 */
interface IncomingRequest {
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

interface OutgoingResponse {
  status?: (code: number) => OutgoingResponse
  code?: (code: number) => OutgoingResponse
  setHeader?: (name: string, value: string) => void
  set?: (name: string, value: string) => OutgoingResponse
  json?: (body: unknown) => void
  send?: (body: unknown) => void
  write?: (chunk: string) => void
  end?: () => void
  // Fastify raw response
  raw?: {
    setHeader(name: string, value: string): void
    write(chunk: string): void
    end(): void
  }
}

type NextFunction = (err?: unknown) => void

export type RequestHandler = (
  req: IncomingRequest,
  res: OutgoingResponse,
  next?: NextFunction,
) => void | Promise<void>

export interface MiddlewareOptions {
  /** Defaults to '/v1/chat/completions' — not used for routing, just documentation */
  path?: string
  /** Extract userId from request; defaults to req.body.user ?? 'anonymous' */
  extractUserId?: (req: IncomingRequest) => string
  /** Inject org/team/dept context from request */
  extractContext?: (req: IncomingRequest) => RequestContext
}

interface OpenAIMessage {
  role: string
  content: string
}

interface OpenAIBody {
  model?: unknown
  messages?: unknown
  stream?: unknown
  temperature?: unknown
  max_tokens?: unknown
  user?: unknown
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function sendError(res: OutgoingResponse, code: number, message: string): void {
  const body = { error: { message, type: 'invalid_request_error' } }
  if (res.status) {
    res.status(code)
    res.json ? res.json(body) : res.send?.(body)
  } else if (res.code) {
    res.code(code).send?.(body)
  }
}

function sendJson(res: OutgoingResponse, body: unknown): void {
  if (res.json) {
    res.json(body)
  } else if (res.send) {
    if (res.set) res.set('content-type', 'application/json')
    else res.setHeader?.('content-type', 'application/json')
    res.send(JSON.stringify(body))
  }
}

function writeSSE(res: OutgoingResponse, data: string): void {
  const line = `data: ${data}\n\n`
  if (res.write) {
    res.write(line)
  } else {
    res.raw?.write(line)
  }
}

function endSSE(res: OutgoingResponse): void {
  writeSSE(res, '[DONE]')
  if (res.end) res.end()
  else res.raw?.end()
}

function setSSEHeaders(res: OutgoingResponse): void {
  const headers: Record<string, string> = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  }
  for (const [k, v] of Object.entries(headers)) {
    if (res.setHeader) res.setHeader(k, v)
    else if (res.set) res.set(k, v)
    else res.raw?.setHeader(k, v)
  }
}

/**
 * Create an OpenAI-compatible request handler that delegates to FreeRouter.
 *
 * Usage (Express):
 *   app.post('/v1/chat/completions', createMiddleware(router))
 *
 * Usage (Fastify):
 *   fastify.post('/v1/chat/completions', createMiddleware(router))
 */
export function createMiddleware(router: FreeRouter, opts: MiddlewareOptions = {}): RequestHandler {
  const extractUserId = opts.extractUserId ?? ((req: IncomingRequest) => {
    const body = req.body
    if (isObject(body) && typeof body['user'] === 'string') return body['user']
    return 'anonymous'
  })

  const extractContext = opts.extractContext ?? (() => ({}))

  return async (req: IncomingRequest, res: OutgoingResponse, next?: NextFunction) => {
    try {
      const body = req.body as OpenAIBody
      if (!isObject(body)) {
        return sendError(res, 400, 'Request body must be a JSON object')
      }

      const { model, messages, stream, temperature, max_tokens } = body
      if (typeof model !== 'string' || model === '') {
        return sendError(res, 400, 'model is required')
      }
      if (!Array.isArray(messages)) {
        return sendError(res, 400, 'messages must be an array')
      }
      const typedMessages = (messages as unknown[]).filter(
        (m): m is OpenAIMessage => isObject(m) && typeof (m as Record<string, unknown>)['role'] === 'string' && typeof (m as Record<string, unknown>)['content'] === 'string',
      ) as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>

      const userId = extractUserId(req)
      const context = extractContext(req)
      const isStreaming = stream === true

      const chatReq = {
        model,
        messages: typedMessages,
        ...(typeof temperature === 'number' && { temperature }),
        ...(typeof max_tokens === 'number' && { maxTokens: max_tokens }),
        stream: isStreaming,
      }

      if (isStreaming) {
        setSSEHeaders(res)
        const gen = router.chatStream(userId, chatReq, context)
        for await (const chunk of gen) {
          if (!chunk.done) {
            const frame = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
            }
            writeSSE(res, JSON.stringify(frame))
          }
        }
        endSSE(res)
      } else {
        const response = await router.chat(userId, chatReq, context)
        const openaiResponse = {
          id: response.id,
          object: 'chat.completion',
          created: Math.floor(response.finishedAt / 1000),
          model: response.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: response.content },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: response.usage.promptTokens,
            completion_tokens: response.usage.completionTokens,
            total_tokens: response.usage.totalTokens,
          },
        }
        sendJson(res, openaiResponse)
      }
    } catch (err) {
      if (next) {
        next(err)
      } else {
        const message = err instanceof Error ? err.message : 'Internal error'
        sendError(res, 500, message)
      }
    }
  }
}
