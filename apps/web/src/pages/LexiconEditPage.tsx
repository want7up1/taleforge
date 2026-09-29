/**
 * 词库编辑器（2026-09-29 用户要求：词库在网页上维护，平台上的这份就是正本）。
 * 边改边校验：实时显示进 GM 设定的字数与"GM 看到的样子"；保存时旧版自动留档，可回滚。
 * 词库 id 建好就不能改——剧本靠它引用。
 */
import { useEffect, useRef, useState } from 'react'
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { Area, Field, List, Text, Words } from '../components/form.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { blankLexicon, cleanLexicon, issueText, pathLabel, type LexiconDraft } from '../drafts.ts'
import { Link, navigate } from '../router.tsx'
import { ErrorCard, formatDateTime } from './common.tsx'

const MAX_CHARS = 8000

export function LexiconEditPage({ lexiconId }: { lexiconId?: string }) {
  const creating = lexiconId === undefined
  const dialog = usePixelDialog()
  const [draft, setDraft] = useState<LexiconDraft | undefined>(creating ? blankLexicon() : undefined)
  const [loadError, setLoadError] = useState<string>()
  const [dirty, setDirty] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; issues?: { path: string; message: string }[]; rendered?: string; chars?: number }>()
  const [note, setNote] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [versions, setVersions] = useState<{ name: string; savedAt: number; words: number }[]>([])
  const checkSeq = useRef(0)

  const loadVersions = () => {
    if (lexiconId) api.lexiconVersions(lexiconId).then(r => setVersions(r.versions)).catch(() => undefined)
  }

  useEffect(() => {
    if (!lexiconId) return
    api.getLexicon(lexiconId)
      .then(d => setDraft({ ...d, groups: d.groups.map(g => ({ ...g })) }))
      .catch(err => setLoadError(err instanceof Error ? err.message : String(err)))
    loadVersions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lexiconId])

  // 边改边校验（停手半秒后发一次）：字数、错误、GM 看到的样子
  useEffect(() => {
    if (!draft) return
    const seq = ++checkSeq.current
    const timer = setTimeout(() => {
      api.validateLexicon(cleanLexicon(draft)).then((r) => {
        if (seq === checkSeq.current) setCheck(r)
      }).catch(() => undefined)
    }, 500)
    return () => clearTimeout(timer)
  }, [draft])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  if (loadError) return <AppShell><ErrorCard message={loadError} /></AppShell>
  if (!draft) return <AppShell><Loading text="正在读取词库…" /></AppShell>

  const edit = (patch: Partial<LexiconDraft>) => {
    setDraft({ ...draft, ...patch })
    setDirty(true)
    setNote(undefined)
  }
  const words = draft.groups.reduce((n, g) => n + g.words.length, 0)
  const chars = check?.chars

  const save = async () => {
    setSaving(true)
    setNote(undefined)
    try {
      const body = cleanLexicon(draft)
      const result = creating ? await api.createLexicon(body) : await api.updateLexicon(lexiconId, body)
      setNote(result.brief)
      if (!result.ok) {
        if (result.issues) setCheck({ ok: false, issues: result.issues })
        return
      }
      setDirty(false)
      if (creating && result.id) navigate(`/lexicons/${result.id}`, { replace: true })
      else loadVersions()
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const restore = async (name: string) => {
    if (!lexiconId) return
    if (!(await dialog.confirm('回滚到这个历史版本？当前版会先自动留档，回滚后还能滚回来。用着它的冒险从下一回合起就用回滚后的版本。', { confirmLabel: '回滚' }))) return
    try {
      const result = await api.restoreLexiconVersion(lexiconId, name)
      setNote(result.brief)
      if (result.ok) {
        const fresh = await api.getLexicon(lexiconId)
        setDraft(fresh)
        setDirty(false)
        loadVersions()
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <AppShell>
      <section className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="min-w-0">
          <p className="px-eyebrow">LEXICON · {creating ? '新建词库' : '编辑词库'}</p>
          <h1 className="px-heading mt-2 break-words text-2xl sm:text-3xl">{draft.title || '（未命名词库）'}</h1>
          <p className="mt-2 text-sm text-[color:var(--muted)]">
            {draft.groups.length} 组 · {words} 个词 · 进 GM 设定
            <span className={chars !== undefined && chars > MAX_CHARS ? ' text-[color:var(--danger)]' : ''}> {chars ?? '…'} / {MAX_CHARS} 字</span>
            {dirty && <span className="ml-2 text-[color:var(--amber)]">· 有改动未保存</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="px-btn" href="/lexicons">◂ 词库</Link>
          <button className="px-btn px-btn-primary" disabled={saving || (!dirty && !creating)} onClick={() => void save()} type="button">
            {saving ? '保存中…' : creating ? '▸ 建好词库' : '▸ 保存'}
          </button>
        </div>
      </section>

      {note && <div className="px-status whitespace-pre-wrap">{note}</div>}
      {check && !check.ok && check.issues && (
        <ul className="px-warning grid gap-1 text-sm">
          {check.issues.map(i => <li key={`${i.path}|${i.message}`}>{pathLabel(i.path)}：{issueText(i.message)}</li>)}
        </ul>
      )}

      <section className="px-panel px-panel-pad grid gap-4 sm:grid-cols-2">
        <Field label="词库 id" hint={creating ? '小写字母、数字、连字符，建好就不能改——剧本在 craft.lexicons 里写它。' : '建好就不能改。'}>
          <Text mono onChange={id => edit({ id })} placeholder="nsfw-modern" readOnly={!creating} value={draft.id} />
        </Field>
        <Field count={draft.title.length} label="标题" max={40}>
          <Text onChange={title => edit({ title })} placeholder="现代都市用语" value={draft.title} />
        </Field>
        <Field
          count={draft.guide?.length ?? 0}
          hint="这套词怎么用，由词库自己说：用在什么场面、要不要直呼、哪些只进对白。GM 每回合都看得到。"
          label="用法说明（可选）"
          max={600}
          wide
        >
          <Area onChange={guide => edit({ guide })} rows={3} value={draft.guide} />
        </Field>
      </section>

      <section className="px-panel px-panel-pad grid gap-3">
        <h2 className="px-heading text-base">分组</h2>
        <p className="text-xs leading-5 text-[color:var(--muted)]">每组一行进 GM 设定：「组名（备注）：词、词、词」。词用顿号、逗号或换行分隔，整段粘贴也行；同组重复的词自动去掉。</p>
        <List
          addLabel="＋ 加一组"
          create={() => ({ label: '', words: [] })}
          items={draft.groups}
          max={40}
          onChange={groups => edit({ groups })}
          render={(g, set) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field count={g.label.length} label="组名" max={30}>
                <Text onChange={label => set({ ...g, label })} value={g.label} />
              </Field>
              <Field count={g.note?.length ?? 0} label="备注（可选）" max={200}>
                <Text onChange={noteText => set({ ...g, note: noteText })} placeholder="比如：只在对白里出现" value={g.note} />
              </Field>
              <Field count={g.words.length} label="词" unit="个" wide>
                <Words onChange={w => set({ ...g, words: w })} rows={5} value={g.words} />
              </Field>
            </div>
          )}
          title={(g, i) => `${g.label || `第 ${i + 1} 组`} · ${g.words.length} 个词`}
        />
      </section>

      {check?.ok && check.rendered && (
        <details className="px-fold">
          <summary>GM 看到的样子</summary>
          <pre className="px-fold-body whitespace-pre-wrap p-3 font-mono text-xs leading-6 text-[color:var(--muted)]">{check.rendered}</pre>
        </details>
      )}

      {!creating && (
        <section className="px-panel px-panel-pad grid gap-2">
          <h2 className="px-heading text-base">历史版本</h2>
          {versions.length === 0
            ? <p className="text-sm text-[color:var(--muted)]">还没有历史版本——每次保存前的旧版会存在这里，保留最近 10 版。</p>
            : versions.map(v => (
                <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-[color:var(--border)] pb-2 last:border-b-0" key={v.name}>
                  <span className="text-sm">{formatDateTime(v.savedAt, true)} · {v.words} 个词</span>
                  <button className="px-btn min-h-7 px-2 py-0.5 text-xs" onClick={() => void restore(v.name)} type="button">回滚到这版</button>
                </div>
              ))}
        </section>
      )}
    </AppShell>
  )
}
