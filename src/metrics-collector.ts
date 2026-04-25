import type { LatencyBuckets, RouterMetrics } from './types.js'

type RequestOutcome = 'success' | 'failure' | 'blocked'

const BUFFER_SIZE = 1000

interface RequestRecord {
  latencyMs: number
  costUsd: number
  outcome: RequestOutcome
  provider: string
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

function computeLatencyBuckets(records: RequestRecord[]): LatencyBuckets {
  const latencies = records
    .filter(r => r.outcome !== 'blocked')
    .map(r => r.latencyMs)
    .sort((a, b) => a - b)
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  }
}

/**
 * Lightweight in-process metrics collector using a circular buffer.
 * Tracks request counts, latency percentiles, costs, and per-provider breakdowns.
 */
export class MetricsCollector {
  private readonly buffer: Array<RequestRecord | undefined>
  private head = 0
  private count = 0

  constructor(bufferSize = BUFFER_SIZE) {
    this.buffer = new Array<RequestRecord | undefined>(bufferSize).fill(undefined)
  }

  recordRequest(
    provider: string,
    latencyMs: number,
    costUsd: number,
    outcome: RequestOutcome,
  ): void {
    this.buffer[this.head] = { latencyMs, costUsd, outcome, provider }
    this.head = (this.head + 1) % this.buffer.length
    if (this.count < this.buffer.length) this.count++
  }

  snapshot(): RouterMetrics {
    const records = this.buffer.filter((r): r is RequestRecord => r !== undefined)

    let succeeded = 0, failed = 0, blocked = 0, totalUsd = 0, totalTokens = 0
    const byProvider: RouterMetrics['byProvider'] = {}

    for (const r of records) {
      if (r.outcome === 'success') succeeded++
      else if (r.outcome === 'failure') failed++
      else blocked++

      totalUsd += r.costUsd

      const pv = byProvider[r.provider] ?? { requests: 0, errors: 0, totalCostUsd: 0 }
      pv.requests++
      if (r.outcome === 'failure') pv.errors++
      pv.totalCostUsd += r.costUsd
      byProvider[r.provider] = pv
    }

    const total = records.length
    return {
      requests: { total, succeeded, failed, blocked },
      latencyMs: computeLatencyBuckets(records),
      errorRate: total === 0 ? 0 : failed / total,
      spend: { totalUsd, totalTokens },
      byProvider,
    }
  }
}
