/**
 * 可视化编辑器的表单小件（剧本编辑器与词库编辑器共用）：带字数与上限的字段框、数字框、下拉、
 * 词表框（顿号/换行分隔）、可增删排序的列表。外观沿用像素皮肤的 px-input / px-card。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { splitWords } from '../drafts.ts'

export function Field({ label, hint, count, max, min, children, wide, unit = '字' }: {
  label: string
  hint?: ReactNode
  /** 当前字数（给了才显示计数） */
  count?: number
  max?: number
  min?: number
  children: ReactNode
  wide?: boolean
  /** 计数的单位：字数用"字"，词表用"个" */
  unit?: string
}) {
  const over = count !== undefined && ((max !== undefined && count > max) || (min !== undefined && count > 0 && count < min))
  return (
    <label className={`grid min-w-0 gap-1.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="px-label">{label}</span>
        {count !== undefined && (
          <span className={`text-xs ${over ? 'text-[color:var(--danger)]' : 'text-[color:var(--faint)]'}`}>
            {count}{max !== undefined ? ` / ${max}` : ''}{min !== undefined ? `（至少 ${min}）` : ''} {unit}
          </span>
        )}
      </span>
      {children}
      {hint && <span className="text-xs leading-5 text-[color:var(--muted)]">{hint}</span>}
    </label>
  )
}

export function Text({ value, onChange, placeholder, mono, readOnly }: { value: string | undefined; onChange: (v: string) => void; placeholder?: string; mono?: boolean; readOnly?: boolean }) {
  return (
    <input
      className={`px-input ${mono ? 'font-mono' : ''}`}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      value={value ?? ''}
    />
  )
}

export function Area({ value, onChange, placeholder, rows = 3 }: { value: string | undefined; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      className="px-input resize-y leading-6"
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      value={value ?? ''}
    />
  )
}

/** 数字框：清空即 undefined（可选字段"不写"） */
export function Num({ value, onChange, placeholder }: { value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string }) {
  return (
    <input
      className="px-input font-mono"
      inputMode="numeric"
      onChange={(e) => {
        const raw = e.target.value.trim()
        if (raw === '' || raw === '-') onChange(undefined)
        else if (/^-?\d+$/.test(raw)) onChange(Number(raw))
      }}
      placeholder={placeholder}
      type="text"
      value={value === undefined ? '' : String(value)}
    />
  )
}

export function Pick<T extends string>({ value, onChange, options, empty }: {
  value: T | undefined
  onChange: (v: T | undefined) => void
  options: readonly (readonly [T, string])[]
  /** 给了就多一个"不选"项 */
  empty?: string
}) {
  return (
    <select className="px-input" onChange={e => onChange((e.target.value || undefined) as T | undefined)} value={value ?? ''}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
    </select>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input checked={checked} className="size-4 accent-[color:var(--phosphor)]" onChange={e => onChange(e.target.checked)} type="checkbox" />
      <span>{children}</span>
    </label>
  )
}

/**
 * 词表框：顿号、逗号、分号或换行分隔。框里保留原文（不然刚敲下的分隔符会被"拆了再拼回去"吃掉），
 * 只在拆出来的词和外面不一致时才用外面的值重写原文。
 */
export function Words({ value, onChange, placeholder, rows = 3 }: { value: readonly string[] | undefined; onChange: (v: string[]) => void; placeholder?: string; rows?: number }) {
  const [raw, setRaw] = useState(() => (value ?? []).join('、'))
  useEffect(() => {
    if (splitWords(raw).join('\u0000') !== (value ?? []).join('\u0000')) setRaw((value ?? []).join('、'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <textarea
      className="px-input resize-y leading-6"
      onChange={(e) => {
        setRaw(e.target.value)
        onChange(splitWords(e.target.value))
      }}
      placeholder={placeholder ?? '用顿号、逗号或换行分隔'}
      rows={rows}
      value={raw}
    />
  )
}

/** 字符串列表（规则、禁止揭露、口吻样例……）：每条一个框，可增删排序。 */
export function Lines({ value, onChange, placeholder, rows = 2, addLabel = '＋ 加一条', max }: {
  value: readonly string[] | undefined
  onChange: (v: string[]) => void
  placeholder?: string
  rows?: number
  addLabel?: string
  max?: number
}) {
  const items = value ?? []
  return (
    <List
      addLabel={addLabel}
      create={() => ''}
      items={items}
      max={max}
      onChange={onChange}
      render={(item, set) => <Area onChange={set} placeholder={placeholder} rows={rows} value={item} />}
    />
  )
}

/**
 * 可增删、可上下挪的列表。每项一张卡；title 给了就做成可折叠的卡（长列表——幕、人物、资源——默认收起）。
 */
export function List<T>({ items, onChange, render, create, addLabel = '＋ 添加', title, max, openNew = true }: {
  items: readonly T[]
  onChange: (items: T[]) => void
  render: (item: T, set: (next: T) => void, index: number) => ReactNode
  create: () => T
  addLabel?: string
  title?: (item: T, index: number) => ReactNode
  max?: number
  /** 新加的项默认展开 */
  openNew?: boolean
}) {
  const [opened, setOpened] = useState<number | undefined>(undefined)
  const set = (i: number, next: T) => onChange(items.map((x, j) => (j === i ? next : x)))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const tools = (i: number) => (
    <span className="flex shrink-0 gap-1">
      <button className="px-btn min-h-7 px-2 py-0.5 text-xs" disabled={i === 0} onClick={() => move(i, -1)} title="上移" type="button">↑</button>
      <button className="px-btn min-h-7 px-2 py-0.5 text-xs" disabled={i === items.length - 1} onClick={() => move(i, 1)} title="下移" type="button">↓</button>
      <button className="px-btn px-btn-danger min-h-7 px-2 py-0.5 text-xs" onClick={() => onChange(items.filter((_, j) => j !== i))} title="删除" type="button">✕</button>
    </span>
  )
  return (
    <div className="grid gap-2">
      {items.map((item, i) => title
        ? (
            <details className="px-fold" key={i} open={opened === i ? true : undefined}>
              <summary className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-left">{title(item, i)}</span>
                <span onClick={e => e.preventDefault()}>{tools(i)}</span>
              </summary>
              <div className="px-fold-body grid gap-3 p-3">{render(item, next => set(i, next), i)}</div>
            </details>
          )
        : (
            <div className="flex items-start gap-2" key={i}>
              <div className="min-w-0 flex-1">{render(item, next => set(i, next), i)}</div>
              {tools(i)}
            </div>
          ))}
      {(max === undefined || items.length < max) && (
        <button
          className="px-btn w-fit"
          onClick={() => {
            onChange([...items, create()])
            if (openNew) setOpened(items.length)
          }}
          type="button"
        >
          {addLabel}
        </button>
      )}
    </div>
  )
}
