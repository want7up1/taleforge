/**
 * 创造炉（外观移植自 Rpgforge 的 ADVENTURE FORGE）：道路 → 锻造 → 启程。
 * TaleForge 开局要先有剧本，所以三扇门是：从剧本库挑一部、和工坊访谈写一部、导入外部写好的一部。
 * Rpgforge 的"设定看板"（表单式改剧本）不搬——改剧本走唤起 GM。
 */
import { useState } from 'react'
import { api } from '../api.ts'
import { AppShell } from '../components/AppShell.tsx'
import { ChatView } from '../components/ChatView.tsx'
import { navigate } from '../router.tsx'
import type { CredentialStatus, StoryDetail } from '../types.ts'
import { EmptyText, useLoad } from './common.tsx'
import { MODULE_NAME, mechanicsSummary } from './scenarioBits.tsx'

type Door = 'library' | 'ai' | 'import'

export function NewGamePage({ credential }: { credential?: CredentialStatus }) {
  const [door, setDoor] = useState<Door>('library')
  const [scenarios, reloadScenarios] = useLoad(() => api.listScenarios().then(r => r.items), [])
  const [picked, setPicked] = useState<StoryDetail>()
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const [importText, setImportText] = useState('')
  const [importIssues, setImportIssues] = useState<string[]>([])
  const [workshopId, setWorkshopId] = useState<string>()
  const blocked = credential !== undefined && !credential.configured

  const pick = async (id: string) => {
    setError(undefined)
    try {
      setPicked(await api.scenario(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const openDoor = async (next: Door) => {
    setDoor(next)
    setError(undefined)
    if (next === 'ai' && !workshopId) {
      try {
        setWorkshopId((await api.workshop()).sessionId)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
    if (next === 'library') reloadScenarios()
  }

  const start = async () => {
    if (!picked) return
    setPending('start')
    setError(undefined)
    try {
      const { sessionId } = await api.createSession(picked.id)
      navigate(`/games/${sessionId}/play`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPending(undefined)
    }
  }

  const importStory = async () => {
    setError(undefined)
    setImportIssues([])
    let parsed: unknown
    try {
      parsed = JSON.parse(importText)
    } catch {
      setError('剧本 JSON 解析失败：请确认粘贴的是合法 JSON。')
      return
    }
    setPending('import')
    try {
      const result = await api.importStory(parsed)
      if (!result.ok) {
        setImportIssues((result.issues ?? []).map(i => `${i.path}：${i.message}`))
        setError(`校验失败 ${result.issues?.length ?? 0} 处`)
        return
      }
      if (result.id) await pick(result.id)
      reloadScenarios()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(undefined)
    }
  }

  const step = picked ? 3 : door === 'library' ? 1 : 2

  return (
    <AppShell>
      <section className="px-panel px-panel-strong px-panel-pad">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0">
            <p className="px-eyebrow">ADVENTURE FORGE</p>
            <h1 className="px-heading mt-2 text-3xl">创造炉</h1>
            <div className="forge-steps mt-3" aria-label="创建流程">
              <ForgeStep index={1} label="道路" current={step} />
              <ForgeStep index={2} label="锻造" current={step} />
              <ForgeStep index={3} label="启程" current={step} />
            </div>
          </div>
          {picked && (
            <button className="px-btn px-btn-primary" disabled={pending !== undefined || blocked} onClick={() => void start()} type="button">
              {pending === 'start' ? '开局中…' : '▸ 开始冒险'}
            </button>
          )}
        </div>
      </section>

      {blocked && <section className="px-warning">还没有配置 DeepSeek API Key——先去「系统设置」填入，才能开局和访谈。</section>}

      {!picked && (
        <section className="grid gap-3 sm:grid-cols-3">
          <DoorButton active={door === 'library'} numeral="Ⅰ" title="从剧本库开局" text="挑一部已经写好的剧本，直接开始一局新的冒险。" onClick={() => void openDoor('library')} />
          <DoorButton active={door === 'ai'} numeral="Ⅱ" title="AI 访谈写剧本" text="和工坊对话，逐步确认世界观、人物、幕与机制，发布后回到这里开局。" onClick={() => void openDoor('ai')} disabled={blocked} />
          <DoorButton active={door === 'import'} numeral="Ⅲ" title="导入剧本" text="照创作说明书在外部 AI 里写好 story.json，粘贴或上传，校验通过即可开局。" onClick={() => void openDoor('import')} />
        </section>
      )}

      {error && <section className="px-alert">{error}</section>}
      {importIssues.length > 0 && (
        <section className="px-warning">
          <p className="font-bold">⚠ 剧本校验未通过</p>
          <ul className="mt-2 grid gap-1 pl-5">{importIssues.map(i => <li className="list-disc" key={i}>{i}</li>)}</ul>
        </section>
      )}

      {!picked && door === 'library' && (
        <section className="grid gap-3">
          {scenarios.status === 'loading' && <p className="px-status"><span className="px-caret" aria-hidden="true" /> 正在读取剧本库…</p>}
          {scenarios.status === 'error' && <p className="px-alert">{scenarios.message}</p>}
          {scenarios.status === 'ready' && scenarios.data.length === 0 && <EmptyText>剧本库还是空的——走第 Ⅱ、Ⅲ 扇门先写一部。</EmptyText>}
          {scenarios.status === 'ready' && scenarios.data.map((sc, i) => (
            <button className="save-slot text-left" key={sc.id} onClick={() => void pick(sc.id)} type="button">
              <span className="save-slot-index">SCRIPT {i + 1}</span>
              <strong className="pr-20">{sc.name}</strong>
              {sc.description && <span className="text-sm leading-6 text-[color:var(--muted)]">{sc.description}</span>}
            </button>
          ))}
        </section>
      )}

      {!picked && door === 'ai' && workshopId && (
        <>
          <section className="px-panel px-panel-pad">
            <p className="px-label">工坊访谈</p>
            <p className="mt-2 text-sm leading-7 text-[color:var(--muted)]">
              说说你想要什么样的剧本。工坊会一步步追问并替你补血肉；它发布之后，回到第 Ⅰ 扇门就能看到新剧本并开局。
            </p>
          </section>
          <ChatView sessionId={workshopId} opening="你好，我想创作一个新剧本。" agentLabel="工坊" placeholder="说说你想要什么样的剧本" />
          <div className="flex flex-wrap gap-2">
            <button className="px-btn" onClick={() => void openDoor('library')} type="button">◂ 回剧本库挑刚发布的剧本</button>
            <button
              className="px-btn"
              onClick={() => void api.workshopReset().then(r => setWorkshopId(r.sessionId)).catch(err => setError(String(err)))}
              type="button"
            >
              ↺ 重开访谈
            </button>
          </div>
        </>
      )}

      {!picked && door === 'import' && (
        <section className="px-panel px-panel-pad grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <a className="px-btn" href="/app/authoring-guide">⇩ 下载创作说明书</a>
            <label className="px-btn cursor-pointer">
              ⇧ 上传 .json
              <input
                accept=".json,application/json"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (file) setImportText(await file.text())
                  e.target.value = ''
                }}
                type="file"
              />
            </label>
            <span className="text-xs text-[color:var(--muted)]">把说明书连同你的想法发给外部 AI，拿到 story.json 粘贴到下方。同 id 会覆盖更新（旧版自动留档）。</span>
          </div>
          <textarea
            className="px-input min-h-[200px] resize-y font-mono text-sm leading-6"
            onChange={e => setImportText(e.target.value)}
            placeholder="在此粘贴 story.json…"
            value={importText}
          />
          <div>
            <button className="px-btn px-btn-primary" disabled={pending !== undefined || !importText.trim()} onClick={() => void importStory()} type="button">
              {pending === 'import' ? '校验中…' : '▸ 校验并导入'}
            </button>
          </div>
        </section>
      )}

      {picked && (
        <section className="px-panel px-panel-strong px-panel-pad grid gap-3">
          <p className="px-label">第三幕 · 启程</p>
          <h2 className="px-heading text-xl">{picked.title}</h2>
          <p className="text-sm leading-6 text-[color:var(--muted)]">{picked.tagline}</p>
          <div className="flex flex-wrap gap-2">
            {picked.world.tone.map(t => <span className="px-badge" key={t}>{t}</span>)}
            {picked.craft?.modules.map(m => <span className="px-badge px-badge-amber" key={m}>{MODULE_NAME[m] ?? m}</span>)}
            {mechanicsSummary(picked).map(m => <span className="px-badge" key={m}>{m}</span>)}
          </div>
          <p className="text-sm leading-6"><b>{picked.protagonist.name}</b><span className="text-[color:var(--muted)]"> —— {picked.protagonist.identity}</span></p>
          <p className="text-sm leading-6 text-[color:var(--muted)]">第一幕《{picked.acts[0]?.title}》：{picked.acts[0]?.objective}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="px-btn px-btn-primary min-w-56" disabled={pending !== undefined || blocked} onClick={() => void start()} type="button">
              {pending === 'start' ? '开局中…' : '▸ 开始冒险'}
            </button>
            <button className="px-btn" onClick={() => setPicked(undefined)} type="button">◂ 换一部</button>
          </div>
        </section>
      )}
    </AppShell>
  )
}

function ForgeStep({ index, label, current }: { index: number; label: string; current: number }) {
  const state = current === index ? 'active' : current > index ? 'done' : 'todo'
  return (
    <span aria-current={state === 'active' ? 'step' : undefined} className={state === 'active' ? 'forge-step forge-step-active' : state === 'done' ? 'forge-step forge-step-done' : 'forge-step'}>
      {state === 'done' ? '✓' : `${index}`} · {label}
    </span>
  )
}

function DoorButton({ active, numeral, title, text, onClick, disabled }: { active: boolean; numeral: string; title: string; text: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button className={`forge-door ${active ? 'forge-door-active' : ''}`} disabled={disabled} onClick={onClick} type="button">
      <span className="px-font text-lg text-[color:var(--amber)]">{numeral}</span>
      <span className="px-heading text-base">{title}</span>
      <span className="text-xs leading-5 text-[color:var(--muted)]">{text}</span>
    </button>
  )
}
