/**
 * 游玩页：布局与组件移植自 Rpgforge（顶栏 / 卷轴正文 / 命令栏、手账抽屉、抉择卡、目标横幅、
 * 在场角色条、结局卡、新手引导），数据接 TaleForge 的内核：选项来自结算步，面板来自会话视图，
 * 另保留 TaleForge 独有的数值条、骰子卡、升级加点、场外 GM 浮窗、重写与撤销。
 * 观测类面板（token、缓存、思考过程）按护栏 4/6 不搬。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api } from '../api.ts'
import { knownCastIds, mentionedIn, type CastMember } from '../cast.ts'
import { AppShell, Brand } from '../components/AppShell.tsx'
import { CharacterModal, CharacterPortrait } from '../components/CharacterModal.tsx'
import { GameMenuLinks } from '../components/GameMenu.tsx'
import { GmChat, type GmChatItem } from '../components/GmChat.tsx'
import { levelLabel, levelPct, LevelStrip, MeterPanel, MeterStrip, placementOf } from '../components/Meters.tsx'
import { ModelPicker } from '../components/ModelPicker.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { StoryMarkdown } from '../components/StoryMarkdown.tsx'
import { Link } from '../router.tsx'
import { parseTurn } from '../turn.ts'
import type { ModelCatalog, ProgressSnapshot, StoryDetail } from '../types.ts'
import { useGameSession, type Panels } from '../useGameSession.ts'
import type { TurnDigest } from '../fold.ts'

type ActionMode = 'action' | 'say' | 'story' | 'continue'

const ONBOARDING_KEY = 'taleforge.onboarding.play.v1'
const OPTION_KEYS = ['A', 'B', 'C', 'D']

// 四种输入模式的说明，引导卡与模式按钮 tooltip 共用，保证文案一致。
const MODE_GUIDE: { key: ActionMode; label: string; hint: string }[] = [
  { key: 'action', label: '行动', hint: '做一件事。例：我撬开抽屉翻找钥匙。' },
  { key: 'say', label: '对话', hint: '说一句话，会以「」引出。例：出口在哪？' },
  { key: 'story', label: '叙述', hint: '推动镜头/旁白方向。例：镜头转向门外的脚步声。' },
  { key: 'continue', label: '继续', hint: '留空直接发送，让 GM 顺势推进剧情。' },
]

/** 按档位包装自由输入：只换外包装，不碰 GM 契约；手打的【场外】原样放行。 */
function wrapByMode(mode: ActionMode, text: string): string {
  const t = text.trim()
  if (mode === 'continue') return t || '继续推进剧情。'
  if (!t || t.startsWith('【场外】')) return t
  if (mode === 'say') return `你说：「${t.replace(/^[「"“]+|[」"”]+$/g, '')}」`
  if (mode === 'story') return `（旁白：${t}）`
  return t
}

export function PlayPage({ gameId }: { gameId: string }) {
  const s = useGameSession(gameId)
  const dialog = usePixelDialog()
  const [story, setStory] = useState<StoryDetail>()
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [modelOpen, setModelOpen] = useState(false)
  const [journalOpen, setJournalOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [gmOpen, setGmOpen] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [actionMode, setActionMode] = useState<ActionMode>('action')
  const [input, setInput] = useState('')
  const [selected, setSelected] = useState<CastMember>()
  const [showOnboarding, setShowOnboarding] = useState(false)
  /** 待分配的加点（属性 id → 点数）：在手账里攒，随下一步行动发送，由代码直接落账 */
  const [alloc, setAlloc] = useState<Record<string, number>>({})
  /** 待领取的奖励（组 id → 选中的候选名）：和加点一样随下一步行动发送，由代码落账 */
  const [claims, setClaims] = useState<Record<string, string>>({})
  const [rewardsOpen, setRewardsOpen] = useState(false)
  const scrollRef = useRef<HTMLElement>(null)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    api.sessionStory(gameId).then(setStory).catch(() => undefined)
    api.sessionModel(gameId).then(setCatalog).catch(() => undefined)
    setAlloc({})
    setClaims({})
  }, [gameId])

  // 首次进游玩页弹一次引导卡，localStorage 记忆后不再打扰
  useEffect(() => {
    try {
      if (!window.localStorage.getItem(ONBOARDING_KEY)) setShowOnboarding(true)
    } catch {
      // 隐私模式等拿不到 localStorage：静默跳过
    }
  }, [])

  useEffect(() => {
    document.documentElement.classList.add('gameplay-scroll-lock')
    document.body.classList.add('gameplay-scroll-lock')
    window.scrollTo(0, 0)
    return () => {
      document.documentElement.classList.remove('gameplay-scroll-lock')
      document.body.classList.remove('gameplay-scroll-lock')
    }
  }, [])

  const syncScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) setHasMore(el.scrollHeight - el.scrollTop - el.clientHeight > 120)
  }, [])
  // 新回合从头开始读；流式输出不跟随滚动——生成比阅读快，页面追着长文跑反而没法读
  useEffect(() => {
    s.onTurnStart.current = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0
      requestAnimationFrame(syncScroll)
    }
  }, [s.onTurnStart, syncScroll])
  useEffect(() => {
    requestAnimationFrame(syncScroll)
  }, [s.messages, s.streaming, s.digest, composerOpen, syncScroll])

  const { mechanics, attributes, progress, progression, rewards, stats } = s.panels
  const chapters = s.messages.filter(m => m.role === 'assistant' && m.kind === 'play')
  const latest = chapters.length ? parseTurn(chapters[chapters.length - 1].text) : undefined
  const lastAction = [...s.messages].reverse().find(m => m.role === 'user' && m.kind === 'play')?.text
  const turnNo = stats?.turns ?? 0
  const ended = progress?.phase === 'ended'
  const offstreaming = s.offstreaming
  const mainStreaming = offstreaming ? '' : s.streaming
  const idle = !s.running && !s.streaming
  const cast = useMemo(() => story?.cast ?? [], [story])

  // 防剧透：只有名字在正文里真实出现过的人物才算"已出场"
  const knownCast = useMemo(() => {
    const corpus = `${chapters.map(m => m.text).join('\n')}\n${mainStreaming}`
    return knownCastIds(cast, corpus)
  }, [chapters, mainStreaming, cast])
  const knownList = useMemo(() => cast.filter(c => knownCast.has(c.id)), [cast, knownCast])
  const present = useMemo(() => mentionedIn(knownList, mainStreaming || latest?.narrative || ''), [knownList, mainStreaming, latest])

  const options = idle && !ended && latest ? s.digest.options.map((label, i) => ({ key: OPTION_KEYS[i], label })) : []
  const scene = useMemo(() => {
    const source = mainStreaming || latest?.narrative || ''
    const headings = [...source.matchAll(/^#{3,4}\s+(.+)$/gm)]
    return headings.length ? headings[headings.length - 1][1] : undefined
  }, [mainStreaming, latest])
  const currentAct = progress?.acts[progress.actIndex]

  const allocLine = useMemo(() => {
    const parts = Object.entries(alloc)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${attributes?.defs.find(d => d.id === id)?.label ?? id} +${n}`)
    return parts.length ? `【加点】${parts.join('、')}` : ''
  }, [alloc, attributes])

  // 每领一组写一行（组名：候选名），界面照抄待领取清单里的原文，内核按原文对上
  const claimLines = useMemo(() => (rewards?.pending ?? [])
    .filter(o => claims[o.id])
    .map(o => `【领取】${o.title}：${claims[o.id]}`), [claims, rewards])

  const send = async (text: string) => {
    if (!text.trim()) return
    setComposerOpen(false)
    setInput('')
    setActionMode('action')
    // 手打的【场外】走场外协议，加点与领取都不能搭这班车
    const extras = text.trimStart().startsWith('【场外】') ? [] : [allocLine, ...claimLines].filter(Boolean)
    await s.send(extras.length ? `${text.trim()}\n${extras.join('\n')}` : text)
    if (extras.length) {
      setAlloc({})
      setClaims({})
      setRewardsOpen(false)
    }
  }

  const submitComposer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = wrapByMode(actionMode, input)
    if (text) void send(text)
  }

  const undo = async () => {
    if (turnNo < 2) return
    const ok = await dialog.confirm(`撤销第 ${turnNo} 回合？这一回合的剧情会被移除（原稿留档），回到第 ${turnNo - 1} 回合重新选择。`, { confirmLabel: '撤销' })
    if (ok) await s.rewind(turnNo - 1)
  }

  const dismissOnboarding = () => {
    setShowOnboarding(false)
    try {
      window.localStorage.setItem(ONBOARDING_KEY, '1')
    } catch {
      // 写不进去最多下次再弹一次
    }
  }

  const gmItems = useMemo<GmChatItem[]>(() =>
    s.messages
      .filter(m => m.kind === 'offstage')
      .map(m => ({ role: m.role === 'user' ? 'you' : 'gm', text: m.text.replace(/^\s*[（(]场外[)）]\s*/, '') })), [s.messages])

  const stripDefs = mechanics?.defs.filter(d => placementOf(d) === 'strip') ?? []
  const showStrip = Boolean((progression && progression.display !== 'panel') || stripDefs.length)

  return (
    <AppShell variant="gameplay">
      <div className="game-screen relative">
        <div>
          <div className="px-topbar border-x-0 border-t-0">
            <Brand size="text-[0.55rem]" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-bold">{story?.title ?? '冒险'}</h1>
              <p className="truncate text-xs text-[color:var(--muted)]">
                第 {turnNo} 回合
                {currentAct ? ` · ${ended ? '剧终' : currentAct.title}` : ''}
                {scene ? ` · ${scene}` : ''}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {turnNo >= 2 && (
                <button className="px-btn min-h-8 px-2 py-1 text-xs" disabled={!idle || Boolean(s.busy)} onClick={() => void undo()} title="删除最新一回合，回到上一回合重新选择" type="button">
                  ↩ 撤销
                </button>
              )}
              {/* 手机上藏进菜单：.px-btn 自带 display，压过 Tailwind 分层的 hidden，所以隐藏套在外层 */}
              <span className="hidden sm:inline-flex">
                <button className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => setModelOpen(true)} title="切换本局模型" type="button">
                  ▨ {catalog?.current.model.replace(/^deepseek-(v4-)?/, '') ?? '…'}
                </button>
              </span>
              <button aria-expanded={journalOpen} className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => { setJournalOpen(v => !v); setMenuOpen(false) }} type="button">
                ▤ 手账
              </button>
              <button aria-expanded={menuOpen} className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => { setMenuOpen(v => !v); setJournalOpen(false) }} type="button">
                ▦ 菜单
              </button>
            </div>
          </div>
          {showStrip && (
            <div className="status-strip">
              {progression && progression.display !== 'panel' && <LevelStrip progression={progression} onClick={() => setJournalOpen(true)} />}
              {mechanics && <MeterStrip snapshot={mechanics} knownCast={knownCast} />}
            </div>
          )}
          {menuOpen && (
            <div className="border-b-2 border-[color:var(--border)] bg-[rgba(5,12,7,0.96)] px-2 py-2">
              <GameMenuLinks gameId={gameId} active="play" className="px-menu justify-center" />
              <div className="mt-2 flex justify-center sm:hidden">{/* 与上面的桌面按钮互补 */}
                <button className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => setModelOpen(true)} type="button">▨ 本局模型：{catalog?.current.model.replace(/^deepseek-(v4-)?/, '') ?? '…'}</button>
              </div>
            </div>
          )}
        </div>

        <section className="game-scroll" ref={scrollRef} onScroll={syncScroll}>
          <div className="game-scroll-column">
            {s.error ? <div className="px-alert mb-4">{s.error}</div> : null}
            {ended && idle && story ? <EndingCard gameId={gameId} title={story.title} acts={progress?.acts.length ?? 0} /> : null}
            {!ended && progress ? <ObjectiveBanner progress={progress} /> : null}
            {present.length > 0 && (
              <section className="present-strip mb-4" aria-label="当前在场角色">
                <div className="present-name-list">
                  {present.map(c => (
                    <button className="present-name-chip" key={c.id} onClick={() => setSelected(c)} type="button">{c.name}</button>
                  ))}
                </div>
              </section>
            )}

            <div className="grid gap-4">
              {lastAction && idle && turnNo > 0 && (
                <article className="scroll-block scroll-block-player">
                  <div className="story-label">你 · 第 {turnNo} 回合</div>
                  <p className="px-wrap mt-1 whitespace-pre-wrap text-base leading-8">&gt; {lastAction}</p>
                </article>
              )}

              {s.running && !offstreaming && (
                <article className="scroll-block">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="story-label">GM · {s.phase ?? '落笔中'}</div>
                    <button className="px-btn px-btn-danger min-h-8 px-2 py-1 text-xs" onClick={s.cancel} type="button">■ 停止</button>
                  </div>
                  <div className="px-progress">
                    <div className="flex flex-wrap justify-between gap-2 text-xs font-bold text-[color:var(--foreground)]">
                      <span>{s.phase ?? '落笔中'}{mainStreaming ? ` · 已写 ${mainStreaming.length} 字` : ''}</span>
                      <span>已等待 {Math.floor(s.elapsed)} 秒</span>
                    </div>
                    <div className="px-progress-track" role="progressbar" aria-label="本回合生成中">
                      <div className="px-progress-fill" style={{ width: `${phaseProgress(s.phase, mainStreaming.length)}%` }} />
                    </div>
                  </div>
                </article>
              )}

              <article className="scroll-block">
                <div className="story-label">
                  GM · {s.running && !offstreaming ? '实时书写' : turnNo > 0 ? `第 ${turnNo} 回合` : '序章'}
                </div>
                {mainStreaming || latest
                  ? (
                      <StoryMarkdown
                        characters={knownList}
                        className="mt-3"
                        content={mainStreaming || latest?.narrative || ''}
                        onCharacterClick={setSelected}
                        showCaret={Boolean(mainStreaming)}
                      />
                    )
                  : (
                      <p className="mt-4 text-sm leading-6 text-[color:var(--muted)]">
                        {s.running ? '正在等待剧情正文…' : s.started ? '开场没有写成。' : '正在开场…'}
                      </p>
                    )}
              </article>

              {/* 开场那一回合失败或被停掉：没有正文可读，也就没有选项——给一个重新开场的出口 */}
              {!latest && idle && s.started && (
                <button className="px-btn px-btn-primary w-fit" disabled={Boolean(s.busy)} onClick={() => void s.retry()} type="button">
                  {s.busy === 'retry' ? '正在重新开场…' : '↻ 重新开场'}
                </button>
              )}

              {/* 空白回合自愈：模型把整回合写进推理通道时，给玩家一个明确的出口 */}
              {s.emptyTurn && idle && !ended && (
                <section className="px-warning grid gap-2">
                  <p>上一回合的正文没有送达（模型输出跑进了内部通道）。</p>
                  <button className="px-btn w-fit" onClick={() => { s.setEmptyTurn(false); void s.retry() }} type="button">↻ 重新生成这一回合</button>
                </section>
              )}

              {s.digest.check && idle && <CheckCard check={s.digest.check} />}
              {idle && turnNo > 0 && <SettlementCard digest={s.digest} panels={s.panels} knownCast={knownCast} />}

              {idle && !ended && progression && (progression.unspent > 0 || allocLine) && (
                <div className="alloc-box">
                  <span>{allocLine ? `◆ 待分配：${allocLine.replace('【加点】', '')}（随下一步行动生效）` : `◆ 你有 ${progression.unspent} 点属性点未分配`}</span>
                  <span className="flex gap-2">
                    <button className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => setJournalOpen(true)} type="button">{allocLine ? '调整' : '去加点'}</button>
                    {allocLine && <button className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => setAlloc({})} type="button">清除</button>}
                  </span>
                </div>
              )}

              {idle && !ended && rewards && rewards.pending.length > 0 && (
                <section className="alloc-box reward-box">
                  <div className="flex w-full flex-wrap items-center justify-between gap-2">
                    <span>
                      {claimLines.length
                        ? `◆ 已选 ${claimLines.length} 组${rewards.label}：${rewards.pending.filter(o => claims[o.id]).map(o => claims[o.id]).join('、')}（随下一步行动生效）`
                        : `◆ 有 ${rewards.pending.length} 组${rewards.label}待领取`}
                    </span>
                    <span className="flex gap-2">
                      <button className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => setRewardsOpen(o => !o)} type="button">{rewardsOpen ? '收起' : claimLines.length ? '调整' : '去领取'}</button>
                      {claimLines.length > 0 && <button className="px-btn min-h-8 px-2 py-1 text-xs" onClick={() => setClaims({})} type="button">清除</button>}
                    </span>
                  </div>
                  {rewardsOpen && rewards.pending.map(offer => (
                    <div className="grid w-full gap-2" key={offer.id}>
                      <p className="text-xs font-bold">{offer.title}（第 {offer.turn} 回合 · 选一个）</p>
                      <div className="grid gap-2 sm:grid-cols-3">
                        {offer.choices.map(choice => (
                          <button
                            aria-pressed={claims[offer.id] === choice.title}
                            className={`reward-pick ${claims[offer.id] === choice.title ? 'reward-pick-active' : ''}`}
                            key={choice.title}
                            onClick={() => setClaims(c => (c[offer.id] === choice.title ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== offer.id)) : { ...c, [offer.id]: choice.title }))}
                            type="button"
                          >
                            <strong>{choice.title}</strong>
                            {choice.detail && <span>{choice.detail}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {rewardsOpen && <p className="w-full text-xs text-[color:var(--muted)]">选好之后照常选一个行动（或自己输入），领取会随这一步一起生效；没选的候选作废。</p>}
                </section>
              )}

              {options.length > 0 && (
                <section className="scroll-block">
                  <div className="story-label">抉择</div>
                  <div className="choice-grid">
                    {options.map(o => (
                      <button
                        aria-label={`选择建议行动 ${o.key}：${o.label}`}
                        className="choice-card"
                        disabled={Boolean(s.busy)}
                        key={o.key}
                        onClick={() => void send(`${o.key}. ${o.label}`)}
                        type="button"
                      >
                        <span className="choice-key">{o.key}</span>
                        <span className="choice-copy">{o.label}</span>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {idle && !ended && latest && (
                <button className="mx-auto text-xs text-[color:var(--faint)] underline-offset-4 hover:text-[color:var(--muted)] hover:underline" disabled={Boolean(s.busy)} onClick={() => void s.retry()} type="button">
                  {s.busy === 'retry' ? '↻ 正在回退重写…' : '↻ 对这一回合不满意——重写'}
                </button>
              )}
            </div>
          </div>
        </section>

        {hasMore && (
          <button className="px-btn absolute bottom-24 left-1/2 z-30 min-h-8 -translate-x-1/2 px-3 py-1 text-xs" onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })} type="button">
            ▼ 还有内容
          </button>
        )}

        {ended
          ? (
              <footer className="command-bar">
                <p className="mx-auto w-full max-w-[840px] text-sm text-[color:var(--muted)]">本场冒险已抵达结局。可以回顾旅程，或开启新的冒险。</p>
              </footer>
            )
          : (
              <Composer
                expanded={composerOpen}
                disabled={!idle || Boolean(s.busy)}
                input={input}
                mode={actionMode}
                onExpanded={setComposerOpen}
                onInput={setInput}
                onMode={setActionMode}
                onSubmit={submitComposer}
              />
            )}
      </div>

      {journalOpen && (
        <>
          <button aria-label="关闭冒险手账" className="journal-overlay" onClick={() => setJournalOpen(false)} type="button" />
          <JournalDrawer
            gameId={gameId}
            story={story}
            panels={s.panels}
            knownCast={knownCast}
            knownList={knownList}
            alloc={alloc}
            onAlloc={(id, delta) => setAlloc((prev) => {
              const n = Math.max(0, (prev[id] ?? 0) + delta)
              const next = { ...prev }
              if (n > 0) next[id] = n
              else delete next[id]
              return next
            })}
            onCharacter={setSelected}
            onClose={() => setJournalOpen(false)}
          />
        </>
      )}

      <CharacterModal character={selected} role="出场人物" onClose={() => setSelected(undefined)} />

      <button
        className={`gm-fab${s.running && offstreaming ? ' busy' : ''}${gmOpen ? ' on' : ''}`}
        onClick={() => setGmOpen(o => !o)}
        title="场外——问 GM、改设定"
        type="button"
      >
        GM
      </button>
      <GmChat
        open={gmOpen}
        items={gmItems}
        streaming={offstreaming && s.streaming ? s.streaming.replace(/^\s*[（(]场外[)）]\s*/, '') : undefined}
        busy={s.running && offstreaming}
        onSend={text => void s.sendOffstage(text)}
        onClose={() => setGmOpen(false)}
      />

      {modelOpen && catalog && (
        <ModelPicker
          catalog={catalog}
          onClose={() => setModelOpen(false)}
          onPick={async (selection) => {
            await api.setSessionModel(gameId, selection)
            setCatalog(await api.sessionModel(gameId))
            setModelOpen(false)
          }}
        />
      )}
      {showOnboarding && <OnboardingCard onDismiss={dismissOnboarding} />}
    </AppShell>
  )
}

/** 阶段 → 进度条长度：只是"还在动"的示意，不是真实完成度 */
function phaseProgress(phase: string | undefined, chars: number): number {
  if (phase === '结算中') return 92
  if (chars > 0) return Math.min(85, 30 + chars / 60)
  if (phase === '掷骰判定') return 25
  return 12
}

function ObjectiveBanner({ progress }: { progress: ProgressSnapshot }) {
  const act = progress.acts[progress.actIndex]
  if (!act) return null
  const required = act.anchors.filter(a => a.required)
  const done = required.filter(a => progress.achieved.includes(a.id)).length
  return (
    <section className="quest-banner" aria-label="当前目标">
      <div className="flex flex-wrap items-center gap-2">
        <span className="story-label">⚑ 当前目标</span>
        <span className="px-badge px-badge-amber">第 {progress.actIndex + 1} 幕 · {act.title}</span>
        {required.length > 0 && <span className="ml-auto text-xs text-[color:var(--muted)]">本幕 {done}/{required.length}</span>}
      </div>
      <p className="px-wrap mt-1.5 text-[0.95rem] font-semibold leading-7">{act.objective}</p>
      {progress.phase === 'finale' && <p className="mt-1 text-sm text-[color:var(--amber)]">主线已全部达成——下一步就是结局。</p>}
    </section>
  )
}

function EndingCard({ gameId, title, acts }: { gameId: string; title: string; acts: number }) {
  return (
    <section className="ending-screen mb-5" aria-label="剧终">
      <div className="flex flex-wrap items-center gap-3">
        <span className="ending-badge">THE END</span>
        <span className="text-sm text-[color:var(--muted)]">你走完了《{title}》{acts > 0 ? ` · 共 ${acts} 幕` : ''}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link className="px-btn px-btn-primary" href="/games/new">▸ 开启新冒险</Link>
        <Link className="px-btn" href={`/games/${gameId}/history`}>回顾旅程</Link>
        <Link className="px-btn" href="/games">所有存档</Link>
      </div>
    </section>
  )
}

function CheckCard({ check }: { check: NonNullable<TurnDigest['check']> }) {
  return (
    <div className={`check-card o-${check.outcome}`}>
      <span className="check-reason">⚄ {check.reason}</span>
      <span className="check-math">
        {check.die} = {check.roll}
        {check.attribute ? ` + ${check.attrValue}` : ''}
        {check.modifier !== 0 ? ` ${check.modifier > 0 ? '+' : '−'} ${Math.abs(check.modifier)}` : ''}
        {' '}vs 难度 {check.difficulty}
      </span>
      <b className="check-outcome">{{ 'crit-success': '大成功', 'success': '成功', 'fail': '失败', 'crit-fail': '大失败' }[check.outcome]}</b>
    </div>
  )
}

function SettlementCard({ digest, panels, knownCast }: { digest: TurnDigest; panels: Panels; knownCast: Set<string> }) {
  const { mechanics, attributes, progression } = panels
  const xp = digest.xp
  const rows = digest.settlement.filter((c) => {
    // hidden 选位与未出场人物的数值只记账不展示（GM 侧照常可见）
    const def = mechanics?.defs.find(d => d.id === c.id)
    return !def || (placementOf(def) !== 'hidden' && (!def.revealWith || knownCast.has(def.revealWith)))
  })
  const hasXp = xp && (xp.applied !== 0 || xp.pointsGranted > 0)
  if (!rows.length && !digest.inventory.length && !hasXp) return null
  return (
    <article className="px-card px-card-green">
      <div className="story-label">战报 · 本回合变化</div>
      <div className="mt-2 grid">
        {xp && xp.applied !== 0 && (
          <div className="settle-row">
            <b className={xp.applied > 0 ? 'up' : 'down'}>{xp.applied > 0 ? `+${xp.applied}` : xp.applied}</b>
            <span>{progression?.label ?? '经验'}</span>
            <span className="settle-after">→ {xp.after}{progression?.next != null ? `/${progression.next}` : ''}</span>
            <span className="settle-reason">{xp.reason}</span>
          </div>
        )}
        {xp && xp.levelAfter > xp.levelBefore && (
          <div className="settle-row levelup">
            <b className="up">▲</b>
            <span className="settle-label">升级！{levelLabel(progression ?? {}, xp.levelBefore)} → {levelLabel(progression ?? {}, xp.levelAfter)}</span>
            <span className="settle-after">获得 {xp.pointsGranted - (xp.bonusPoints ?? 0)} 点属性点</span>
          </div>
        )}
        {xp && (xp.bonusPoints ?? 0) > 0 && (
          <div className="settle-row levelup">
            <b className="up">◆</b>
            <span className="settle-label">剧情奖励</span>
            <span className="settle-after">+{xp.bonusPoints} 点属性点（待分配）</span>
          </div>
        )}
        {rows.map((c, i) => (
          <div key={`${c.id}-${i}`} className="settle-row">
            <b className={c.applied > 0 ? 'up' : 'down'}>{c.applied > 0 ? `+${c.applied}` : c.applied}</b>
            <span>{mechanics?.defs.find(d => d.id === c.id)?.label ?? attributes?.defs.find(d => d.id === c.id)?.label ?? c.id}</span>
            <span className="settle-after">→ {c.after}</span>
            <span className="settle-reason">{c.reason}</span>
          </div>
        ))}
        {digest.inventory.map((c, i) => (
          <div key={`inv-${c.id}-${i}`} className="settle-row">
            <b className={c.delta >= 0 && !c.removed ? 'up' : 'down'}>{c.removed ? '－' : c.delta >= 0 ? `+${c.delta}` : c.delta}</b>
            <span>{c.name}</span>
            <span className="settle-after">{c.removed ? '已失去' : `现有 ${c.qty}`}</span>
            {c.reason && <span className="settle-reason">{c.reason}</span>}
          </div>
        ))}
      </div>
    </article>
  )
}

function Composer({
  expanded,
  disabled,
  input,
  mode,
  onExpanded,
  onInput,
  onMode,
  onSubmit,
}: {
  expanded: boolean
  disabled: boolean
  input: string
  mode: ActionMode
  onExpanded: (v: boolean) => void
  onInput: (v: string) => void
  onMode: (m: ActionMode) => void
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!expanded) return
    const frame = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [expanded])

  if (!expanded) {
    return (
      <footer className="command-bar">
        <div className="mx-auto flex w-full max-w-[840px] justify-end">
          <button aria-expanded="false" className="px-btn px-btn-primary min-h-9" disabled={disabled} onClick={() => onExpanded(true)} type="button">
            ＋ 自定义行动
          </button>
        </div>
      </footer>
    )
  }

  return (
    <footer className="command-bar">
      <form className="mx-auto grid w-full max-w-[840px] gap-2" onSubmit={onSubmit}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="mode-switch" aria-label="输入模式">
            {MODE_GUIDE.map(m => (
              <button className={mode === m.key ? 'mode-active' : undefined} key={m.key} onClick={() => onMode(m.key)} title={m.hint} type="button">{m.label}</button>
            ))}
          </div>
          <span className="hidden text-xs text-[color:var(--faint)] sm:inline">{MODE_GUIDE.find(m => m.key === mode)?.hint}</span>
          <button aria-expanded="true" className="px-btn ml-auto min-h-8 px-2 py-1 text-xs" onClick={() => onExpanded(false)} type="button">− 收起</button>
        </div>
        <div className="flex items-start gap-2 border-2 border-[color:var(--border-strong)] bg-[color:var(--input)] px-3 py-2 shadow-[inset_2px_2px_0_0_rgba(0,0,0,0.45)] focus-within:border-[color:var(--phosphor)]">
          <span aria-hidden="true" className="command-prompt mt-0.5">&gt;</span>
          <label className="sr-only" htmlFor="free-action-input">自由行动</label>
          <textarea
            className="command-input"
            disabled={disabled}
            id="free-action-input"
            onChange={e => onInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder={placeholderFor(mode)}
            ref={ref}
            rows={2}
            value={input}
          />
          <button className="px-btn px-btn-primary min-h-9 self-end" disabled={disabled || (mode !== 'continue' && !input.trim())} type="submit">
            {mode === 'continue' ? '继续' : '发送'} ▸
          </button>
        </div>
      </form>
    </footer>
  )
}

function placeholderFor(mode: ActionMode): string {
  if (mode === 'say') return '输入你要说的话。例：跟紧我，别出声。'
  if (mode === 'story') return '输入你希望推动的叙述方向。例：镜头转向门外的脚步声。'
  if (mode === 'continue') return '留空发送，直接让 GM 继续推进当前剧情。'
  return '输入你的行动。例：我从污物电梯井潜入药房。'
}

function JournalDrawer({
  gameId,
  story,
  panels,
  knownCast,
  knownList,
  alloc,
  onAlloc,
  onCharacter,
  onClose,
}: {
  gameId: string
  story?: StoryDetail
  panels: Panels
  knownCast: Set<string>
  knownList: CastMember[]
  alloc: Record<string, number>
  onAlloc: (id: string, delta: number) => void
  onCharacter: (c: CastMember) => void
  onClose: () => void
}) {
  const { mechanics, attributes, inventory, progress, progression, stats } = panels
  const pending = Object.values(alloc).reduce((a, b) => a + b, 0)
  const remaining = Math.max(0, (progression?.unspent ?? 0) - pending)
  const act = progress?.acts[progress.actIndex]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside aria-label="冒险手账" className="journal-drawer">
      <div className="flex items-center justify-between gap-2 border-b-2 border-[color:var(--border)] px-3 py-2.5">
        <h2 className="px-heading text-sm">冒险手账</h2>
        <button aria-label="关闭冒险手账" className="px-btn h-8 w-8 px-0" onClick={onClose} type="button">×</button>
      </div>
      <div className="journal-body grid content-start gap-3">
        <section className="px-card px-card-green">
          <div className="font-bold text-[color:var(--phosphor)]">{story?.protagonist.name ?? '主角'}</div>
          {story?.protagonist.identity && <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">{story.protagonist.identity}</p>}
          {act && <p className="mt-1.5 text-xs text-[color:var(--muted)]">第 {(progress?.actIndex ?? 0) + 1} 幕 · {act.title}</p>}
          <Link className="px-btn mt-2 w-full" href={`/games/${gameId}/status`}>查看状态 STATUS ▸</Link>
        </section>

        {mechanics && mechanics.defs.some(d => placementOf(d) !== 'hidden') && (
          <section className="px-card">
            <MeterPanel snapshot={mechanics} knownCast={knownCast} />
          </section>
        )}

        {progression && (
          <section className="px-card">
            <h3 className="px-label">等级</h3>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <b className="text-[color:var(--phosphor)]">{levelLabel(progression, progression.level)}</b>
              <span className="text-xs text-[color:var(--muted)]">{progression.label} {progression.xp}{progression.next !== null ? ` / ${progression.next}` : '（满级）'}</span>
            </div>
            <div className="level-track"><i style={{ width: `${levelPct(progression)}%` }} /></div>
            {(progression.unspent > 0 || pending > 0) && (
              <p className="text-xs text-[color:var(--amber)]">未分配属性点 {remaining} 点{pending > 0 ? `——已选 ${pending} 点，随下一步行动生效` : '——在下方属性表加点'}</p>
            )}
          </section>
        )}

        {attributes && attributes.defs.length > 0 && (
          <section className="px-card">
            <h3 className="px-label">属性</h3>
            <div className="attr-table mt-2">
              {attributes.defs.map((d) => {
                const value = attributes.state[d.id]?.value ?? d.initial
                const p = alloc[d.id] ?? 0
                return (
                  <div key={d.id} className="attr-row">
                    <span>{d.label}</span>
                    <span className="attr-ctl">
                      {p > 0 && <i className="attr-pending">+{p}</i>}
                      <b>{value}</b>
                      {progression && (progression.unspent > 0 || p > 0) && (
                        <>
                          <button className="attr-btn" disabled={p === 0} onClick={() => onAlloc(d.id, -1)} title="撤回一点" type="button">−</button>
                          <button className="attr-btn" disabled={remaining <= 0 || value + p >= d.max} onClick={() => onAlloc(d.id, 1)} title="加一点" type="button">＋</button>
                        </>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {inventory && (
          <section className="px-card">
            <h3 className="px-label">物品</h3>
            {inventory.items.length === 0
              ? <p className="mt-2 text-sm text-[color:var(--muted)]">两手空空。</p>
              : inventory.items.map(it => (
                  <div key={it.id} className="inv-row">
                    <span>{it.name}</span>
                    {it.qty > 1 && <b className="inv-qty">×{it.qty}</b>}
                    {it.note && <span className="text-xs text-[color:var(--muted)]">{it.note}</span>}
                  </div>
                ))}
          </section>
        )}

        <section className="px-card">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="px-label">角色</h3>
            <Link className="text-xs text-[color:var(--phosphor)]" href={`/games/${gameId}/characters`}>全部 ▸</Link>
          </div>
          <div className="grid gap-3">
            {knownList.length > 0
              ? knownList.slice(0, 3).map(c => (
                  <button className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-3 text-left" key={c.id} onClick={() => onCharacter(c)} type="button">
                    <CharacterPortrait name={c.name} />
                    <div className="min-w-0">
                      <strong className="block truncate">{c.name}</strong>
                      <p className="truncate text-xs text-[color:var(--muted)]">{c.identity}</p>
                    </div>
                  </button>
                ))
              : <p className="text-sm text-[color:var(--muted)]">还没有遇到别的人。</p>}
          </div>
        </section>

        {stats && (
          <section className="px-card">
            <h3 className="px-label">本局</h3>
            <p className="mt-2 text-sm text-[color:var(--muted)]">{stats.turns} 回合 · 生成 {Math.round(stats.llmMs / 1000)} 秒</p>
          </section>
        )}
      </div>
    </aside>
  )
}

function OnboardingCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="px-modal-overlay" role="dialog" aria-modal="true" aria-label="新手引导">
      <div className="px-modal max-w-md">
        <p className="px-eyebrow">HOW TO PLAY</p>
        <h2 className="px-heading mt-2 text-xl">开始你的冒险</h2>
        <p className="mt-3 text-sm leading-6 text-[color:var(--muted)]">
          这是一场由 AI 主持的文字 RPG。每一章写完，下方会给出几个抉择；
          <strong className="text-[color:var(--foreground)]">你也可以尝试任何行动</strong>——点「＋ 自定义行动」写下你想做的事。四种输入模式只是帮你表达意图：
        </p>
        <ul className="mt-3 grid gap-2">
          {MODE_GUIDE.map(m => (
            <li className="grid grid-cols-[3.2rem_minmax(0,1fr)] items-baseline gap-2 text-sm leading-6" key={m.key}>
              <span className="font-bold text-[color:var(--amber)]">{m.label}</span>
              <span className="px-wrap text-[color:var(--muted)]">{m.hint}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm leading-6 text-[color:var(--muted)]">
          右下角的 <strong className="text-[color:var(--amber)]">GM</strong> 是场外通道：问机制、问剧情安排、改设定都在那里说，不影响正文。
        </p>
        <button className="px-btn px-btn-primary mt-4 w-full" onClick={onDismiss} type="button">▸ 知道了，开始冒险</button>
      </div>
    </div>
  )
}
