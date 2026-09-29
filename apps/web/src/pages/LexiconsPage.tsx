/**
 * 词库（货架件）：平台级的用词表，剧本在 craft.lexicons 里写上 id 才会用它。
 * 平台上的这份就是正本（2026-09-29 用户改定）：在网页上新建、编辑（LexiconEditPage），
 * 这里列出全部词库，另有 JSON 导入导出——批量迁移与离线备份用。
 */
import { useState } from 'react'
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { Link } from '../router.tsx'
import type { LexiconItem } from '../types.ts'
import { EmptyText, ErrorCard, useLoad } from './common.tsx'

export function LexiconsPage() {
  const [state, reload] = useLoad(() => api.listLexicons().then(r => r.items), [])
  const dialog = usePixelDialog()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [note, setNote] = useState<string>()
  const [issues, setIssues] = useState<string[]>([])

  const importLexicon = async () => {
    setNote(undefined)
    setIssues([])
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setNote('词库 JSON 解析失败：请确认粘贴的是合法 JSON。')
      return
    }
    setPending(true)
    try {
      const result = await api.importLexicon(parsed)
      setNote(result.brief)
      if (!result.ok) {
        setIssues((result.issues ?? []).map(i => `${i.path}：${i.message}`))
        return
      }
      setText('')
      reload()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  const remove = async (lexicon: LexiconItem) => {
    const typed = await dialog.prompt(`删除词库《${lexicon.title}》？平台上的这份会被移除，不可恢复——正本应该在你的写作文件夹里，没有的话先导出留底。`, {
      title: '删除词库',
      expect: lexicon.title,
      placeholder: lexicon.title,
      danger: true,
      confirmLabel: '删除',
    })
    if (typed === null) return
    try {
      await api.deleteLexicon(lexicon.id)
      setNote(`已删除词库《${lexicon.title}》。`)
      reload()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <AppShell>
      <section className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <p className="px-eyebrow">LEXICON · 词库</p>
          <h1 className="px-heading mt-2 text-3xl sm:text-4xl">词库</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--muted)]">
            平台级的用词表，指导 GM 用什么词写。剧本在 craft.lexicons 里写上词库 id 才会用它，不写就没有。
            改了保存，用着它的冒险从下一回合起就用新版；每次保存前的旧版自动留档，可回滚。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="px-btn" href="/library">◂ 剧本库</Link>
          <Link className="px-btn px-btn-primary" href="/lexicons/new">＋ 新建词库</Link>
        </div>
      </section>

      <details className="px-fold">
        <summary>导入 JSON（批量迁移、恢复备份）</summary>
        <div className="px-fold-body grid gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="px-btn cursor-pointer">
            ⇧ 上传 .json
            <input
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) setText(await file.text())
                e.target.value = ''
              }}
              type="file"
            />
          </label>
          <span className="text-xs text-[color:var(--muted)]">格式见创作说明书的「词库文件」一节。同 id 覆盖（旧版留档）。</span>
        </div>
        <textarea
          className="px-input resize-y font-mono text-sm leading-6"
          rows={8}
          onChange={e => setText(e.target.value)}
          placeholder="在此粘贴词库 JSON…"
          value={text}
        />
        <div>
          <button className="px-btn px-btn-primary" disabled={pending || !text.trim()} onClick={() => void importLexicon()} type="button">
            {pending ? '校验中…' : '▸ 校验并导入'}
          </button>
        </div>
        {note && <div className="px-status whitespace-pre-wrap">{note}</div>}
        {issues.length > 0 && (
          <ul className="px-warning grid gap-1 text-sm">
            {issues.map(i => <li key={i}>{i}</li>)}
          </ul>
        )}
        </div>
      </details>

      {state.status === 'loading'
        ? <Loading text="正在读取词库…" />
        : state.status === 'error'
          ? <ErrorCard message={state.message} />
          : state.data.length === 0
            ? <EmptyText>还没有词库——点「新建词库」建第一个，或者导入 JSON。</EmptyText>
            : (
                <section className="grid gap-3 md:grid-cols-2">
                  {state.data.map(lexicon => (
                    <article className="px-card grid gap-2" key={lexicon.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link className="text-lg font-bold" href={`/lexicons/${lexicon.id}`}>{lexicon.title}</Link>
                        <span className="px-badge">{lexicon.id}</span>
                      </div>
                      {lexicon.failed
                        ? <p className="px-warning text-sm">文件坏了，运行时跳过：{lexicon.failed}</p>
                        : <p className="text-sm text-[color:var(--muted)]">{lexicon.groups} 组 · {lexicon.words} 个词 · 进 GM 设定约 {lexicon.chars} 字</p>}
                      <p className="text-sm leading-6">
                        {lexicon.usedBy.length
                          ? <>用在：{lexicon.usedBy.map((s, i) => <span key={s.id}>{i > 0 && '、'}<Link href={`/library/${s.id}`}>《{s.title}》</Link></span>)}</>
                          : <span className="text-[color:var(--muted)]">还没有剧本用它</span>}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {!lexicon.failed && <Link className="px-btn px-btn-primary" href={`/lexicons/${lexicon.id}`}>✎ 编辑</Link>}
                        {!lexicon.failed && <a className="px-btn" href={`/app/lexicons/${lexicon.id}/export`}>⇩ 导出</a>}
                        <button
                          className="px-btn px-btn-danger"
                          disabled={lexicon.usedBy.length > 0}
                          onClick={() => void remove(lexicon)}
                          title={lexicon.usedBy.length ? '还有剧本用着它：先从那些剧本的 craft.lexicons 里去掉' : undefined}
                          type="button"
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  ))}
                </section>
              )}
    </AppShell>
  )
}
