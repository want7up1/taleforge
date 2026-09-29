/**
 * 系统询问框：替代原生 confirm/prompt，与界面同一套像素皮肤（原生弹窗在手机 Safari 上是一块
 * 白色系统框，把 CRT 氛围整个打断）。外观移植自 Rpgforge。Provider + hook，同一时刻只有一个询问；`expect` 用于
 * 不可逆操作——必须原样输入指定文字才允许确认。借自 Rpgforge 的 PixelDialog 形态。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

export interface ConfirmOptions {
  title?: string
  confirmLabel?: string
  /** 危险操作：确认键走红色描边 */
  danger?: boolean
}

export interface PromptOptions extends ConfirmOptions {
  defaultValue?: string
  placeholder?: string
  /** 必须原样输入这段文字才允许确认（删剧本这类级联且不可恢复的操作） */
  expect?: string
}

export interface PixelDialogApi {
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>
  prompt: (message: string, opts?: PromptOptions) => Promise<string | null>
}

type Request =
  | { seq: number; kind: 'confirm'; message: string; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { seq: number; kind: 'prompt'; message: string; opts: PromptOptions; resolve: (v: string | null) => void }

const Ctx = createContext<PixelDialogApi | undefined>(undefined)

export function usePixelDialog(): PixelDialogApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('usePixelDialog 必须在 PixelDialogProvider 之内使用')
  return api
}

/** 按取消收尾一个询问：调用方的 await 不能悬空 */
const cancel = (r: Request) => {
  if (r.kind === 'confirm') r.resolve(false)
  else r.resolve(null)
}

export function PixelDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request>()
  const live = useRef<Request>(undefined)
  const seq = useRef(0)

  const open = useCallback((next: Request) => {
    // 新询问顶掉旧的
    if (live.current) cancel(live.current)
    live.current = next
    setRequest(next)
  }, [])

  const close = useCallback(() => {
    live.current = undefined
    setRequest(undefined)
  }, [])

  const api = useMemo<PixelDialogApi>(() => ({
    confirm: (message, opts = {}) =>
      new Promise<boolean>(resolve => open({ seq: ++seq.current, kind: 'confirm', message, opts, resolve })),
    prompt: (message, opts = {}) =>
      new Promise<string | null>(resolve => open({ seq: ++seq.current, kind: 'prompt', message, opts, resolve })),
  }), [open])

  return (
    <Ctx.Provider value={api}>
      {children}
      {request && <Dialog key={request.seq} request={request} onDone={close} />}
    </Ctx.Provider>
  )
}

function Dialog({ request, onDone }: { request: Request; onDone: () => void }) {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.opts.defaultValue ?? '' : '')
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const expect = request.kind === 'prompt' ? request.opts.expect : undefined
  const ready = !expect || value.trim() === expect

  const settle = (ok: boolean) => {
    if (request.kind === 'confirm') request.resolve(ok)
    else request.resolve(ok ? value : null)
    onDone()
  }

  // 打开即聚焦（输入框全选 / 确认键），关闭后把焦点还给唤起它的按钮
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    } else {
      okRef.current?.focus()
    }
    return () => previous?.focus?.()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      settle(false)
      return
    }
    if (e.key !== 'Tab') return
    // 焦点在框内循环，不跑到被遮住的页面上
    const nodes = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])
    if (nodes.length === 0) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div aria-modal="true" className="px-modal-overlay" role="dialog" aria-labelledby="ask-title">
      <button aria-label="取消" className="absolute inset-0 cursor-default" onClick={() => settle(false)} type="button" />
      <div className="px-modal max-w-md" ref={boxRef} onKeyDown={onKeyDown}>
        <p className="px-heading text-sm" id="ask-title">{request.opts.title ?? '系统询问'}</p>
        <p className="px-wrap mt-3 whitespace-pre-wrap text-sm leading-6 text-[color:var(--muted)]">{request.message}</p>
        {request.kind === 'prompt' && (
          <>
            <input
              className="px-input mt-3"
              ref={inputRef}
              value={value}
              placeholder={request.opts.placeholder}
              autoComplete="off"
              onChange={e => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  settle(true)
                }
              }}
            />
            {expect && <p className="mt-2 text-xs text-[color:var(--faint)]">原样输入「{expect}」才能确认。</p>}
          </>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className="px-btn" onClick={() => settle(false)} type="button">取消</button>
          <button
            className={request.opts.danger ? 'px-btn px-btn-danger' : 'px-btn px-btn-primary'}
            ref={okRef}
            disabled={!ready}
            onClick={() => settle(true)}
            type="button"
          >
            {request.opts.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
