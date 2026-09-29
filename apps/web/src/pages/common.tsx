/** 各页面共用的小件：异步读取、时间格式、指标格、空状态。 */
import { useCallback, useEffect, useState, type DependencyList, type ReactNode } from 'react'

export const PHASE_LABEL: Record<string, string> = { playing: '进行中', finale: '终幕', ended: '剧终' }

export function formatDateTime(value: number, withYear = false): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || value <= 0) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', {
    ...withYear ? { year: 'numeric' as const } : {},
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string }

/** 进页面读一次数据；reload 手动重读（改动之后刷新用）。 */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): [Loaded<T>, () => void, (data: T) => void] {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' })
  const [tick, setTick] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps)
  useEffect(() => {
    let cancelled = false
    run()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [run, tick])
  return [state, () => setTick(t => t + 1), data => setState({ status: 'ready', data })]
}

export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <article className="px-metric">
      <p className="px-metric-label">{label}</p>
      <p className="px-metric-value">{value}</p>
    </article>
  )
}

export function EmptyText({ children }: { children: ReactNode }) {
  return <p className="px-empty">{children}</p>
}

export function CompactField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-2 border-[color:var(--border)] bg-[color:var(--input)] p-3">
      <p className="px-label">{label}</p>
      <p className="px-wrap mt-1 text-sm font-medium leading-6">{value}</p>
    </div>
  )
}

/** 失败卡片（整页读不到时） */
export function ErrorCard({ message }: { message: string }) {
  return <section className="px-alert">{message}</section>
}
