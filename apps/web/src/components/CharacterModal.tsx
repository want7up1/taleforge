/** 角色档案弹窗与立绘占位（移植自 Rpgforge；立绘先不做，统一用像素首字占位框）。 */
import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { CastMember } from '../cast.ts'

export function CharacterPortrait({ name, className = '' }: { name: string; className?: string }) {
  return (
    <div
      className={`character-portrait-placeholder grid aspect-[3/4] w-full max-w-full self-start place-items-center border-2 border-[color:var(--border)] bg-[color:var(--soft-panel)] ${className}`}
    >
      <div className="character-portrait-initials">{name.slice(0, 2)}</div>
    </div>
  )
}

export function CharacterModal({ character, role, onClose }: { character: CastMember | undefined; role?: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!character) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [character, onClose])

  if (!character) return null

  const trapTab = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab') return
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, textarea, [tabindex]:not([tabindex="-1"])')
    if (!nodes?.length) return
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
    <div aria-modal="true" className="px-modal-overlay items-end sm:items-center" role="dialog" aria-label={`角色档案：${character.name}`}>
      <button aria-label="关闭角色档案" className="absolute inset-0 cursor-default" onClick={onClose} type="button" />
      <article
        className="px-modal max-w-3xl sm:grid sm:grid-cols-[minmax(11rem,0.4fr)_minmax(0,0.6fr)] sm:gap-5"
        onKeyDown={trapTab}
        ref={dialogRef}
      >
        <button aria-label="关闭角色档案" className="px-btn absolute right-3 top-3 h-9 w-9 px-0" onClick={onClose} ref={closeRef} type="button">×</button>
        <div className="mt-8 sm:mt-0">
          <div className="mx-auto w-32 sm:w-full sm:max-w-none">
            <CharacterPortrait name={character.name} />
          </div>
        </div>
        <div className="mt-4 min-w-0 sm:mt-0">
          <div className="flex flex-wrap items-center gap-2 pr-12">
            <h2 className="px-heading break-words text-xl">{character.name}</h2>
            <span className="px-badge px-badge-amber">{role ?? '角色'}</span>
          </div>
          <section className="mt-4">
            <h3 className="px-label">身份介绍</h3>
            <p className="px-wrap mt-2 whitespace-pre-wrap text-sm leading-6 text-[color:var(--muted)]">{character.identity || '暂无。'}</p>
          </section>
        </div>
      </article>
    </div>
  )
}
