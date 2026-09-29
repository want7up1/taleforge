/**
 * 剧本可视化编辑器（2026-09-29 用户要求，取代"改剧本只走唤起 GM"）：按剧本结构分页编辑，
 * 保存即发布新版——旧版自动留档、详情页可回滚，和导入、GM 发布同一条路。
 * 编辑器里的删减是作者亲手做的，不走缩水防线；id 建好就不能改（冒险、修改对话、词库引用都挂在它上面）。
 * 字段的含义与限制以平台 schema 为准：保存前由平台校验，错误带字段路径逐条标回对应的页。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type StoryCheck } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { Area, Check, Field, Lines, List, Num, Pick, Text, Words } from '../components/form.tsx'
import {
  blankAct,
  blankAnchor,
  blankAttribute,
  blankCast,
  blankLore,
  blankResource,
  blankStory,
  draftHints,
  fromDraft,
  issueText,
  pathLabel,
  sectionOf,
  toDraft,
  type Display,
  type MechanicsDraft,
  type ResourceGroup,
  type StoryDraft,
} from '../drafts.ts'
import { Link, navigate } from '../router.tsx'
import type { LexiconItem } from '../types.ts'
import { ErrorCard } from './common.tsx'
import { MODULE_NAME } from './scenarioBits.tsx'

const SECTIONS = [
  ['basic', '基本'],
  ['world', '世界'],
  ['protagonist', '主角'],
  ['cast', '人物'],
  ['opening', '开场'],
  ['acts', '幕与锚点'],
  ['mechanics', '机制'],
  ['craft', '工艺'],
  ['lore', '设定条目'],
  ['json', 'JSON'],
] as const
type Section = (typeof SECTIONS)[number][0]

const GROUPS = [['self', '自身（self）'], ['affinity', '好感（affinity）'], ['world', '队伍与环境（world）']] as const
const DISPLAYS = [['strip', '顶栏常驻（strip）'], ['panel', '卷宗面板（panel）'], ['hidden', '只记账不展示（hidden）']] as const

export function StoryEditorPage({ scenarioId }: { scenarioId?: string }) {
  const creating = scenarioId === undefined
  const [draft, setDraft] = useState<StoryDraft | undefined>(creating ? blankStory() : undefined)
  const [loadError, setLoadError] = useState<string>()
  const [section, setSection] = useState<Section>('basic')
  const [dirty, setDirty] = useState(false)
  const [result, setResult] = useState<StoryCheck>()
  const [note, setNote] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [lexicons, setLexicons] = useState<LexiconItem[]>([])

  useEffect(() => {
    api.listLexicons().then(r => setLexicons(r.items)).catch(() => undefined)
    if (!scenarioId) return
    api.storySource(scenarioId)
      .then(raw => setDraft(toDraft(raw)))
      .catch(err => setLoadError(err instanceof Error ? err.message : String(err)))
  }, [scenarioId])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const hints = useMemo(() => (draft ? draftHints(draft) : []), [draft])

  if (loadError) return <AppShell><ErrorCard message={loadError} /></AppShell>
  if (!draft) return <AppShell><Loading text="正在读取剧本…" /></AppShell>

  const set = (next: StoryDraft) => {
    setDraft(next)
    setDirty(true)
    setNote(undefined)
  }
  const issues = result?.issues ?? []
  const issueCount = (s: Section) => issues.filter(i => sectionOf(i.path) === s).length

  const validate = async () => {
    setNote(undefined)
    try {
      const r = await api.validateStory(fromDraft(draft))
      setResult(r)
      setNote(r.ok ? `校验通过${r.warnings?.length ? `，另有 ${r.warnings.length} 条写法提醒` : ''}。` : `校验没过：${r.issues?.length ?? 0} 处要改。`)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  const save = async () => {
    setSaving(true)
    setNote(undefined)
    try {
      const body = fromDraft(draft)
      const r = creating ? await api.createStory(body) : await api.updateStory(scenarioId, body)
      setResult(r)
      // 平台回的 brief 是写给工坊 GM 看的（"告诉玩家……"），编辑器里换成自己的话
      setNote(r.ok
        ? `已保存并发布${creating ? '' : '，旧版已留档，可在剧本详情页回滚'}。${r.warnings?.length ? `另有 ${r.warnings.length} 条写法提醒，见"编辑器提醒"。` : ''}`
        : r.issues?.length ? `保存没成功：${r.issues.length} 处要改。` : (r.brief ?? '保存没成功。'))
      if (!r.ok) return
      setDirty(false)
      if (creating && r.id) navigate(`/library/${r.id}/editor`, { replace: true })
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppShell>
      <section className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="min-w-0">
          <p className="px-eyebrow">SCRIPT EDITOR · {creating ? '新建剧本' : '编辑剧本'}</p>
          <h1 className="px-heading mt-2 break-words text-2xl sm:text-3xl">{draft.title || '（未命名剧本）'}</h1>
          <p className="mt-2 text-sm text-[color:var(--muted)]">
            {draft.id}
            {dirty && <span className="ml-2 text-[color:var(--amber)]">· 有改动未保存</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="px-btn" href={creating ? '/library' : `/library/${scenarioId}`}>◂ 返回</Link>
          <button className="px-btn" onClick={() => void validate()} type="button">检查</button>
          <button className="px-btn px-btn-primary" disabled={saving || (!dirty && !creating)} onClick={() => void save()} type="button">
            {saving ? '保存中…' : creating ? '▸ 建好剧本' : '▸ 保存并发布'}
          </button>
        </div>
      </section>

      <p className="text-xs leading-5 text-[color:var(--muted)]">
        保存就是发布新版：旧版自动留档，剧本详情页可回滚。进行中的冒险只有贴身提醒、分幕提醒、强度词表、词库、设定条目下一回合就用新的，其余改动对新开的局生效。
      </p>

      {note && <div className="px-status whitespace-pre-wrap">{note}</div>}
      {issues.length > 0 && (
        <ul className="px-warning grid gap-1 text-sm">
          {issues.map(i => (
            <li key={`${i.path}|${i.message}`}>
              <button className="underline" onClick={() => setSection(sectionOf(i.path) as Section)} type="button">{pathLabel(i.path)}</button>：{issueText(i.message)}
            </li>
          ))}
        </ul>
      )}
      {(hints.length > 0 || (result?.warnings?.length ?? 0) > 0) && (
        <details className="px-fold">
          <summary>编辑器提醒 {hints.length + (result?.warnings?.length ?? 0)} 条（不拦保存）</summary>
          <ul className="px-fold-body grid gap-1 p-3 text-sm leading-6 text-[color:var(--muted)]">
            {[...hints, ...result?.warnings ?? []].map(h => <li key={h}>· {h}</li>)}
          </ul>
        </details>
      )}

      <nav className="flex flex-wrap gap-1.5" aria-label="剧本分页">
        {SECTIONS.map(([key, label]) => (
          <button
            className={`px-btn min-h-8 px-2.5 py-1 text-xs ${section === key ? 'px-btn-primary' : ''}`}
            key={key}
            onClick={() => setSection(key)}
            type="button"
          >
            {label}{issueCount(key) > 0 && <span className="ml-1 text-[color:var(--danger)]">·{issueCount(key)}</span>}
          </button>
        ))}
      </nav>

      <section className="px-panel px-panel-pad grid gap-4">
        {section === 'basic' && <BasicSection creating={creating} d={draft} set={set} />}
        {section === 'world' && <WorldSection d={draft} set={set} />}
        {section === 'protagonist' && <ProtagonistSection d={draft} set={set} />}
        {section === 'cast' && <CastSection d={draft} set={set} />}
        {section === 'opening' && <OpeningSection d={draft} set={set} />}
        {section === 'acts' && <ActsSection d={draft} set={set} />}
        {section === 'mechanics' && <MechanicsSection d={draft} set={set} />}
        {section === 'craft' && <CraftSection d={draft} lexicons={lexicons} set={set} />}
        {section === 'lore' && <LoreSection d={draft} set={set} />}
        {section === 'json' && <JsonSection creating={creating} d={draft} set={set} />}
      </section>
    </AppShell>
  )
}

interface SectionProps {
  d: StoryDraft
  set: (next: StoryDraft) => void
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>
}

function Intro({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-[color:var(--muted)]">{children}</p>
}

function BasicSection({ d, set, creating }: SectionProps & { creating: boolean }) {
  return (
    <Grid>
      <Field hint={creating ? 'story- 开头，小写字母、数字、连字符。建好就不能改。' : '建好就不能改。'} label="剧本 id">
        <Text mono onChange={id => set({ ...d, id })} readOnly={!creating} value={d.id} />
      </Field>
      <Field count={d.title.length} label="标题">
        <Text onChange={title => set({ ...d, title })} value={d.title} />
      </Field>
      <Field count={d.tagline.length} hint="一句能让人想点进来的具体处境，不是题材标签。剧本库与详情页公开显示。" label="卖点" wide>
        <Area onChange={tagline => set({ ...d, tagline })} rows={2} value={d.tagline} />
      </Field>
    </Grid>
  )
}

function WorldSection({ d, set }: SectionProps) {
  const w = d.world
  return (
    <>
      <Field count={w.overview.length} hint="公开：开局前就显示在详情页。写成有画面的散文——地方、此刻的处境、普通人怎么过日子、世界的硬规则。不写真相与秘密。" label="世界总纲">
        <Area onChange={overview => set({ ...d, world: { ...w, overview } })} rows={10} value={w.overview} />
      </Field>
      <Field hint="3–8 个能指导写法的词，公开显示为标签。" label="基调">
        <Words onChange={tone => set({ ...d, world: { ...w, tone } })} rows={2} value={w.tone} />
      </Field>
      <Field hint="只有 GM 看得见、每一幕都看得见全部。每条写三件事：事实（具体到人、时间、手段）、谁的动机、2–4 处可以放出的可观察线索。要到第 N 幕才揭开的，记得写进前面各幕的禁止揭露。" label="隐藏真相">
        <List
          addLabel="＋ 加一条真相"
          create={() => ({ id: '', text: '' })}
          items={w.hidden_truths}
          onChange={hidden_truths => set({ ...d, world: { ...w, hidden_truths } })}
          render={(h, setH) => (
            <Grid>
              <Field label="id"><Text mono onChange={id => setH({ ...h, id })} placeholder="ht-mirror" value={h.id} /></Field>
              <Field count={h.text.length} label="内容" wide><Area onChange={text => setH({ ...h, text })} rows={4} value={h.text} /></Field>
            </Grid>
          )}
          title={(h, i) => `${h.id || `真相 ${i + 1}`} · ${h.text.slice(0, 24)}`}
        />
      </Field>
    </>
  )
}

function ProtagonistSection({ d, set }: SectionProps) {
  const p = d.protagonist
  return (
    <Grid>
      <Field label="名字"><Text onChange={name => set({ ...d, protagonist: { ...p, name } })} value={p.name} /></Field>
      <div />
      <Field count={p.identity.length} hint="公开。只写开场时的身份、背景、会什么不会什么、想要什么、有什么毛病。" label="公开设定" wide>
        <Area onChange={identity => set({ ...d, protagonist: { ...p, identity } })} rows={4} value={p.identity} />
      </Field>
      <Field count={p.voice?.length ?? 0} hint="公开（设定页可见）。叙述人称、句子节奏、感官与判断的先后、不替玩家做什么。" label="叙述声音" wide>
        <Area onChange={voice => set({ ...d, protagonist: { ...p, voice } })} rows={3} value={p.voice} />
      </Field>
    </Grid>
  )
}

function CastSection({ d, set }: SectionProps) {
  return (
    <>
      <Intro>
        GM 从第一幕起就能看到全部人物（含暗线）；玩家在详情页开局前就能看到全部人物的公开设定。
        人物是否登场按正文里出现名字（或去掉第一个字后 ≥2 字的部分）判定，名字写正文真会出现的叫法，不带括号别名。
      </Intro>
      <List
        addLabel="＋ 加一个人物"
        create={blankCast}
        items={d.cast}
        onChange={cast => set({ ...d, cast })}
        render={(c, setC) => (
          <Grid>
            <Field hint="kebab-case，建议拼音。数值条的「绑定人物」靠它。" label="id"><Text mono onChange={id => setC({ ...c, id })} value={c.id} /></Field>
            <Field label="名字"><Text onChange={name => setC({ ...c, name })} value={c.name} /></Field>
            <Field count={c.identity.length} hint="公开：初遇时的样子。不写秘密、不写后期才有的身份。" label="公开设定" wide>
              <Area onChange={identity => setC({ ...c, identity })} rows={4} value={c.identity} />
            </Field>
            <Field count={c.secret?.length ?? 0} hint="只给 GM：真实动机与秘密、登场时机（第几幕、在哪、因为什么）、关系弧每一步的具体标志、底线、结局钩子。" label="暗线" wide>
              <Area onChange={secret => setC({ ...c, secret })} rows={6} value={c.secret} />
            </Field>
            <Field hint="2–4 句这个人会说的原话，每句不超过 200 字；覆盖不同情绪，避免口头禅。" label="口吻样例" wide>
              <Lines addLabel="＋ 加一句" max={4} onChange={voice => setC({ ...c, voice })} rows={2} value={c.voice} />
            </Field>
          </Grid>
        )}
        title={(c, i) => `${c.name || `人物 ${i + 1}`} · ${c.id || '（无 id）'}`}
      />
    </>
  )
}

function OpeningSection({ d, set }: SectionProps) {
  const o = d.opening
  return (
    <>
      <Grid>
        <Field count={o.scene.length} hint="第一章的画面：时间、地点、天气、主角在做什么。整局都在 GM 设定里。" label="开场场景" wide>
          <Area onChange={scene => set({ ...d, opening: { ...o, scene } })} rows={3} value={o.scene} />
        </Field>
        <Field count={o.hook.length} hint="第一章必须收在的钩子：一个需要玩家立刻反应的时刻。" label="开场钩子" wide>
          <Area onChange={hook => set({ ...d, opening: { ...o, hook } })} rows={2} value={o.hook} />
        </Field>
      </Grid>
      <Field
        count={o.chapter?.length ?? 0}
        hint="可选，强烈建议写：原文直接作为第 1 回合，也是整局的文风先例。篇幅接近正常一章（2500–3500 字）；只用 **加粗**、*斜体*、### 场景名、> 引用块；收在钩子上；写成的事第 1 回合照样结算。"
        label="手写开场章"
        max={20000}
        min={200}
      >
        <Area onChange={chapter => set({ ...d, opening: { ...o, chapter } })} rows={16} value={o.chapter} />
      </Field>
    </>
  )
}

function ActsSection({ d, set }: SectionProps) {
  return (
    <>
      <Intro>
        每幕至少一个必需锚点（否则进入即跳过）。必需锚点按希望发生的顺序排——"下一个主线事件"永远是本幕第一个没达成的必需锚点。
        锚点描述在状态页对玩家公开；完成信号只给结算用，写成能答"是/否"的可观察事实。
      </Intro>
      <List
        addLabel="＋ 加一幕"
        create={blankAct}
        items={d.acts}
        onChange={acts => set({ ...d, acts })}
        render={(a, setA) => (
          <>
            <Grid>
              <Field hint="kebab-case。定了别改：进行中的局按它读分幕提醒。" label="id"><Text mono onChange={id => setA({ ...a, id })} value={a.id} /></Field>
              <Field label="标题"><Text onChange={title => setA({ ...a, title })} value={a.title} /></Field>
              <Field count={a.objective.length} hint="公开，顶部目标栏每回合都显示。写成主角此刻能去做的具体目标。" label="目标" wide>
                <Area onChange={objective => setA({ ...a, objective })} rows={2} value={a.objective} />
              </Field>
              <Field hint="连续多少回合没有进展才开始催（到两倍时强制下一个必需锚点发生），缺省 4。慢热的幕写大。" label="节奏（pace，可选）">
                <Num onChange={pace => setA({ ...a, pace })} placeholder="4" value={a.pace} />
              </Field>
              <div />
              <Field count={a.reminder?.length ?? 0} hint="本幕进行期间替换全局贴身提醒（不是叠加），全局里每回合都要坚持的话要抄进来。" label="分幕提醒（可选）" max={600} wide>
                <Area onChange={reminder => setA({ ...a, reminder })} rows={3} value={a.reminder} />
              </Field>
              <Field hint="本幕 GM 不能直接说破的主题，短语即可。到了揭开的那一幕就去掉。" label="禁止揭露" wide>
                <Lines addLabel="＋ 加一条" onChange={forbidden_reveals => setA({ ...a, forbidden_reveals })} rows={1} value={a.forbidden_reveals} />
              </Field>
            </Grid>
            <Field label="锚点">
              <List
                addLabel="＋ 加一个锚点"
                create={blankAnchor}
                items={a.anchors}
                onChange={anchors => setA({ ...a, anchors })}
                render={(x, setX) => (
                  <div className="grid gap-3 border-2 border-[color:var(--border)] p-3 sm:grid-cols-2">
                    <Field label="id"><Text mono onChange={id => setX({ ...x, id })} value={x.id} /></Field>
                    <div className="flex items-end pb-2"><Check checked={x.required} onChange={required => setX({ ...x, required })}>必需（全部必需锚点达成才转幕）</Check></div>
                    <Field hint="公开的任务描述：一件具体的事，不暴露隐藏真相。" label="描述" wide><Area onChange={text => setX({ ...x, text })} rows={2} value={x.text} /></Field>
                    <Field hint="只给结算：一句能答是/否的可观察事实（谁、做了什么、结果）。物件类写「到了主角手里」。" label="完成信号" wide>
                      <Area onChange={signal => setX({ ...x, signal })} rows={2} value={x.signal} />
                    </Field>
                  </div>
                )}
              />
            </Field>
          </>
        )}
        title={(a, i) => `第 ${i + 1} 幕 · ${a.title || '（无标题）'} · ${a.anchors.length} 个锚点`}
      />
    </>
  )
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return <Check checked={on} onChange={onChange}>{label}</Check>
}

function MechanicsSection({ d, set }: SectionProps) {
  const m = d.mechanics
  const setM = (next: MechanicsDraft) => set({ ...d, mechanics: next })
  const without = <K extends keyof MechanicsDraft>(key: K): MechanicsDraft => {
    const next = { ...m }
    delete next[key]
    return next
  }
  const resourceIds = (m.resources ?? []).map(r => [r.id, r.label || r.id] as const).filter(([id]) => id)
  const castIds = d.cast.map(c => [c.id, c.name || c.id] as const).filter(([id]) => id)
  return (
    <>
      <Intro>
        声明哪件游戏里就有哪件，全不选就是纯叙事。各条的「说明」只在每章写完后的结算步给 GM（写正文时看不到）：写"什么事件加减多少、恢复规则、各区间含义"。
        数值在正文里怎么体现，写进工艺页的规则，以面板数值为条件（"体力低于 30 时……"）。
      </Intro>

      <Field label="侧栏分组标题（可选）">
        <div className="grid gap-2 sm:grid-cols-3">
          {GROUPS.map(([key, label]) => (
            <Text key={key} onChange={v => setM({ ...m, groups: { ...m.groups, [key]: v } })} placeholder={label} value={m.groups?.[key as ResourceGroup]} />
          ))}
        </div>
      </Field>

      <fieldset className="grid gap-3 border-2 border-[color:var(--border)] p-3">
        <Toggle label="资源条（每几回合就会涨落的量：体力、物资、好感、倒计时）" on={Boolean(m.resources)} onChange={on => setM(on ? { ...m, resources: [blankResource()] } : without('resources'))} />
        {m.resources && (
          <List
            addLabel="＋ 加一条资源"
            create={blankResource}
            items={m.resources}
            onChange={resources => setM({ ...m, resources })}
            render={(r, setR) => (
              <Grid>
                <Field hint="kebab-case，可带一个冒号命名空间。" label="id"><Text mono onChange={id => setR({ ...r, id })} value={r.id} /></Field>
                <Field label="显示名"><Text onChange={label => setR({ ...r, label })} value={r.label} /></Field>
                <Field label="分组"><Pick onChange={g => setR({ ...r, group: g ?? 'self' })} options={GROUPS} value={r.group} /></Field>
                <Field hint="缺省：自身进顶栏，其余进面板。" label="显示位置"><Pick empty="缺省" onChange={display => setR({ ...r, display: display as Display | undefined })} options={DISPLAYS} value={r.display} /></Field>
                <Field label="最小值"><Num onChange={min => setR({ ...r, min })} value={r.min} /></Field>
                <Field label="最大值"><Num onChange={max => setR({ ...r, max })} value={r.max} /></Field>
                <Field label="初值"><Num onChange={initial => setR({ ...r, initial })} value={r.initial} /></Field>
                <Field hint="跌不破的线（可选）。" label="下限"><Num onChange={floor => setR({ ...r, floor })} value={r.floor} /></Field>
                <Field hint="不能小于说明里写的最大单次变化。" label="单次上限"><Num onChange={maxStep => setR({ ...r, maxStep })} value={r.maxStep} /></Field>
                <Field hint="绑定后续登场人物的好感/专属数值一律要绑：人物登场前玩家看不到、结算也不记。" label="绑定人物">
                  <Pick empty="不绑定" onChange={revealWith => setR({ ...r, revealWith })} options={castIds} value={r.revealWith} />
                </Field>
                <Field count={r.guidance.length} label="说明（记账规则）" wide><Area onChange={guidance => setR({ ...r, guidance })} rows={4} value={r.guidance} /></Field>
              </Grid>
            )}
            title={(r, i) => `${r.label || `资源 ${i + 1}`} · ${r.id || '（无 id）'}${r.display === 'hidden' ? ' · 隐藏' : ''}`}
          />
        )}
      </fieldset>

      <fieldset className="grid gap-3 border-2 border-[color:var(--border)] p-3">
        <Toggle label="周期收支（每个正戏回合由代码自动滚一次：口粮日耗、灯油折耗、作物生长）" on={Boolean(m.upkeep)} onChange={on => setM(on ? { ...m, upkeep: [] } : without('upkeep'))} />
        {m.upkeep && (
          <List
            addLabel="＋ 加一条"
            create={() => ({ id: '', delta: -1, reason: '' })}
            items={m.upkeep}
            max={20}
            onChange={upkeep => setM({ ...m, upkeep })}
            render={(u, setU) => (
              <div className="grid gap-3 border-2 border-[color:var(--border)] p-3 sm:grid-cols-2">
                <Field label="资源"><Pick empty="选一条资源" onChange={id => setU({ ...u, id: id ?? '' })} options={resourceIds} value={u.id || undefined} /></Field>
                <Field hint="负数为消耗。" label="每回合变化"><Num onChange={delta => setU({ ...u, delta })} value={u.delta} /></Field>
                <Field label="理由"><Text onChange={reason => setU({ ...u, reason })} value={u.reason} /></Field>
                <Field hint="当前值大于它才滚（种下之后才生长）。" label="生效门槛（可选）"><Num onChange={activeAbove => setU({ ...u, activeAbove })} value={u.activeAbove} /></Field>
              </div>
            )}
          />
        )}
      </fieldset>

      <fieldset className="grid gap-3 border-2 border-[color:var(--border)] p-3">
        <Toggle label="属性（很少变动的能力值，判定时自动加成）" on={Boolean(m.attributes)} onChange={on => setM(on ? { ...m, attributes: [blankAttribute()] } : without('attributes'))} />
        {m.attributes && (
          <List
            addLabel="＋ 加一条属性"
            create={blankAttribute}
            items={m.attributes}
            onChange={attributes => setM({ ...m, attributes })}
            render={(a, setA) => (
              <Grid>
                <Field label="id"><Text mono onChange={id => setA({ ...a, id })} value={a.id} /></Field>
                <Field label="显示名"><Text onChange={label => setA({ ...a, label })} value={a.label} /></Field>
                <Field label="初值"><Num onChange={initial => setA({ ...a, initial })} value={a.initial} /></Field>
                <Field hint="缺省 1。" label="单次上限"><Num onChange={maxStep => setA({ ...a, maxStep })} value={a.maxStep} /></Field>
                <Field hint="缺省 0。" label="最小值"><Num onChange={min => setA({ ...a, min })} value={a.min} /></Field>
                <Field hint="缺省 20。" label="最大值"><Num onChange={max => setA({ ...a, max })} value={a.max} /></Field>
                <Field count={a.guidance.length} hint="衡量什么、什么级别的事件才配 +1，最好写整局次数上限。" label="说明" wide><Area onChange={guidance => setA({ ...a, guidance })} rows={3} value={a.guidance} /></Field>
              </Grid>
            )}
            title={(a, i) => `${a.label || `属性 ${i + 1}`} · ${a.id || '（无 id）'}`}
          />
        )}
      </fieldset>

      <fieldset className="grid gap-3 border-2 border-[color:var(--border)] p-3">
        <Toggle label="判定（成败不确定的行动交给骰子）" on={Boolean(m.checks)} onChange={on => setM(on ? { ...m, checks: { die: 'd20', guidance: '' } } : without('checks'))} />
        {m.checks && (
          <Grid>
            <Field hint="合计 = 骰点 + 属性 + 修正 ≥ 难度即成功；只有 d20 有天然 20 / 天然 1。" label="骰型">
              <Pick onChange={die => setM({ ...m, checks: { ...m.checks!, die: die ?? 'd20' } })} options={[['d20', 'd20'], ['d100', 'd100'], ['2d6', '2d6']] as const} value={m.checks.die} />
            </Field>
            <div />
            <Field count={m.checks.guidance.length} hint="写正文时 GM 看得到。写死：哪几类行动必须掷（各带哪个属性）、难度几档各是多少、哪些情境修正多少。" label="说明" wide>
              <Area onChange={guidance => setM({ ...m, checks: { ...m.checks!, guidance } })} rows={4} value={m.checks.guidance} />
            </Field>
          </Grid>
        )}
      </fieldset>

      <fieldset className="grid gap-3 border-2 border-[color:var(--border)] p-3">
        <Toggle label="物品栏（要账实相符的物件）" on={Boolean(m.inventory)} onChange={on => setM(on ? { ...m, inventory: { guidance: '', initial: [] } } : without('inventory'))} />
        {m.inventory && (
          <>
            <Field count={m.inventory.guidance.length} hint="什么入账、什么不入；成批物资按种类分条给数量；哪些量记在资源里不进物品栏。" label="说明">
              <Area onChange={guidance => setM({ ...m, inventory: { ...m.inventory!, guidance } })} rows={3} value={m.inventory.guidance} />
            </Field>
            <Field hint="开场章里主角带着、用到的东西写在这里；开场章里新拿到的不用写，第 1 回合结算会记上。" label="开局物品">
              <List
                addLabel="＋ 加一件"
                create={() => ({ id: '', name: '', qty: 1 })}
                items={m.inventory.initial}
                onChange={initial => setM({ ...m, inventory: { ...m.inventory!, initial } })}
                render={(it, setIt) => (
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Text mono onChange={id => setIt({ ...it, id })} placeholder="id" value={it.id} />
                    <Text onChange={name => setIt({ ...it, name })} placeholder="名字" value={it.name} />
                    <Num onChange={qty => setIt({ ...it, qty })} placeholder="数量" value={it.qty} />
                    <Text onChange={noteText => setIt({ ...it, note: noteText })} placeholder="备注（可选）" value={it.note} />
                  </div>
                )}
              />
            </Field>
          </>
        )}
      </fieldset>

      <fieldset className="grid gap-3 border-2 border-[color:var(--border)] p-3">
        <Toggle
          label="经验等级（升级发点，玩家自己加到属性上；需要先启用属性）"
          on={Boolean(m.progression)}
          onChange={on => setM(on ? { ...m, progression: { guidance: '', maxStep: 50, thresholds: [100, 250], pointsPerLevel: 1, levelNames: [] } } : without('progression'))}
        />
        {m.progression && (
          <Grid>
            <Field hint="缺省「经验」。" label="显示名"><Text onChange={label => setM({ ...m, progression: { ...m.progression!, label } })} value={m.progression.label} /></Field>
            <Field label="单回合经验上限"><Num onChange={maxStep => setM({ ...m, progression: { ...m.progression!, maxStep } })} value={m.progression.maxStep} /></Field>
            <Field hint="升到 2、3、…级各需累计多少经验，严格递增；个数 + 1 = 满级。" label="升级阈值">
              <Words
                onChange={v => setM({ ...m, progression: { ...m.progression!, thresholds: v.map(Number).filter(n => Number.isFinite(n)) } })}
                rows={1}
                value={m.progression.thresholds.map(String)}
              />
            </Field>
            <Field label="每级给几点属性点"><Num onChange={pointsPerLevel => setM({ ...m, progression: { ...m.progression!, pointsPerLevel } })} value={m.progression.pointsPerLevel} /></Field>
            <Field hint="缺省 0 = 不开放。开了之后 GM 可按说明发剧情奖励点，方向仍由玩家选。" label="剧情奖励点单次上限">
              <Num onChange={bonusPointsMax => setM({ ...m, progression: { ...m.progression!, bonusPointsMax } })} value={m.progression.bonusPointsMax} />
            </Field>
            <Field label="显示位置">
              <Pick empty="缺省（顶栏）" onChange={display => setM({ ...m, progression: { ...m.progression!, display } })} options={[['strip', '顶栏常驻'], ['panel', '只进卷宗']] as const} value={m.progression.display} />
            </Field>
            <Field hint="可选，个数必须等于阈值个数 + 1。" label="各级显示名" wide>
              <Words onChange={levelNames => setM({ ...m, progression: { ...m.progression!, levelNames } })} rows={1} value={m.progression.levelNames} />
            </Field>
            <Field count={m.progression.guidance.length} hint="只写机械规则：什么事件给多少。升级在剧情里怎么体现写进工艺页的规则。" label="说明" wide>
              <Area onChange={guidance => setM({ ...m, progression: { ...m.progression!, guidance } })} rows={3} value={m.progression.guidance} />
            </Field>
          </Grid>
        )}
      </fieldset>
    </>
  )
}

function CraftSection({ d, set, lexicons }: SectionProps & { lexicons: LexiconItem[] }) {
  const c = d.craft
  const setC = (patch: Partial<StoryDraft['craft']>) => set({ ...d, craft: { ...c, ...patch } })
  const unknown = c.lexicons.filter(id => !lexicons.some(l => l.id === id))
  return (
    <Grid>
      <Field hint="按声明顺序生效。standard 几乎都该带；shuang 与 hardcore 气质相反，一般不同时选。" label="工艺模块" wide>
        <div className="flex flex-wrap gap-4">
          {Object.entries(MODULE_NAME).map(([key, label]) => (
            <Check
              checked={c.modules.includes(key)}
              key={key}
              onChange={on => setC({ modules: on ? [...c.modules, key] : c.modules.filter(x => x !== key) })}
            >
              {label}（{key}）
            </Check>
          ))}
        </div>
      </Field>
      <Field count={c.rating?.length ?? 0} hint="内容强度的唯一约定，公开显示在详情页。写到什么程度、哪些一律不写；含性内容时写明涉及的人物都是成年人。" label="内容强度" wide>
        <Area onChange={rating => setC({ rating })} rows={3} value={c.rating} />
      </Field>
      <Field hint="2–4；聚焦的场面 3 个比 4 个有力。" label="每回合选项数">
        <Pick onChange={v => setC({ action_options: Number(v ?? 4) })} options={[['2', '2'], ['3', '3'], ['4', '4']] as const} value={String(c.action_options) as '2' | '3' | '4'} />
      </Field>
      <Field hint="系统流、面板流作品打开；开了之后正文里的数字必须和面板一致。" label="数字进正文">
        <Check checked={c.numbers_in_prose} onChange={numbers_in_prose => setC({ numbers_in_prose })}>正文里可以直接写数值与机制词</Check>
      </Field>
      <Field
        hint="剧本专属的写作规则，无条数上限。配比跟着回合时间走；触发条件写成能查证的事实（位置、次数、阶段、面板数值），不写「适当」「必要时」「日常时」。"
        label="规则"
        wide
      >
        <Lines addLabel="＋ 加一条规则" onChange={rules => setC({ rules })} rows={2} value={c.rules} />
      </Field>
      <Field count={c.reminder?.length ?? 0} hint="每回合贴在 GM 动笔处。写每回合都要坚持、长局里容易漂移的要求。写了分幕提醒的幕里，这段不会发给 GM。" label="全局贴身提醒" max={600} wide>
        <Area onChange={reminder => setC({ reminder })} rows={3} value={c.reminder} />
      </Field>
      <Field hint="探测器：只统计、GM 看不到。只收只在目标语境里出现的词，不收单字和日常词。连续三章零命中才提醒 GM。" label="强度词表" wide>
        <Words onChange={intensity_words => setC({ intensity_words })} rows={2} value={c.intensity_words} />
      </Field>
      <Field hint="最多 3 个，按勾选顺序进 GM 设定。词库在「剧本库 → 词库」维护。" label="词库" wide>
        <div className="grid gap-2">
          {lexicons.length === 0 && <span className="text-sm text-[color:var(--muted)]">平台上还没有词库。</span>}
          <div className="flex flex-wrap gap-4">
            {lexicons.map(l => (
              <Check
                checked={c.lexicons.includes(l.id)}
                key={l.id}
                onChange={on => setC({ lexicons: on ? [...c.lexicons, l.id].slice(0, 3) : c.lexicons.filter(x => x !== l.id) })}
              >
                {l.title}（{l.id} · {l.words} 个词）
              </Check>
            ))}
          </div>
          {unknown.map(id => (
            <span className="text-sm text-[color:var(--amber)]" key={id}>
              引用了平台上没有的词库「{id}」
              <button className="ml-2 underline" onClick={() => setC({ lexicons: c.lexicons.filter(x => x !== id) })} type="button">去掉</button>
            </span>
          ))}
        </div>
      </Field>
      <Field count={c.exemplar?.length ?? 0} hint="可选：示范句长、节奏、尺度、对白密度，适合示范开场章里没有的场面。只学写法——别放后面幕的剧情。" label="范文" max={6000} min={200} wide>
        <Area onChange={exemplar => setC({ exemplar })} rows={10} value={c.exemplar} />
      </Field>
    </Grid>
  )
}

function LoreSection({ d, set }: SectionProps) {
  return (
    <>
      <Intro>
        本回合玩家输入或上一章正文里出现任一触发词（精确匹配）才发给 GM，每回合最多 6 条，命中多时取靠前的——重要的放前面。
        触发词写正文真会出现的写法、带上别名，不用单字和到处都有的词。本幕还不能说破的真相不要写进来。
      </Intro>
      <List
        addLabel="＋ 加一条设定"
        create={blankLore}
        items={d.lore}
        max={200}
        onChange={lore => set({ ...d, lore })}
        render={(l, setL) => (
          <Grid>
            <Field label="id"><Text mono onChange={id => setL({ ...l, id })} value={l.id} /></Field>
            <Field label="标题"><Text onChange={title => setL({ ...l, title })} value={l.title} /></Field>
            <Field count={l.triggers.length} hint="1–12 个。" label="触发词" max={12} unit="个" wide><Words onChange={triggers => setL({ ...l, triggers })} rows={1} value={l.triggers} /></Field>
            <Field count={l.text.length} label="内容" max={1500} wide><Area onChange={text => setL({ ...l, text })} rows={4} value={l.text} /></Field>
          </Grid>
        )}
        title={(l, i) => `${l.title || `设定 ${i + 1}`} · ${l.triggers.slice(0, 4).join('、')}`}
      />
    </>
  )
}

/** 高级：直接看、直接改整份剧本 JSON（批量粘贴、从外部 AI 拿到的整段）。改完点「应用」才回到表单。 */
function JsonSection({ d, set, creating }: SectionProps & { creating: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(fromDraft(d), null, 2))
  const [error, setError] = useState<string>()
  return (
    <>
      <Intro>保存时交给平台的就是这份 JSON（空的可选字段已去掉）。在这里改完点「应用到表单」；{creating ? '' : 'id 不能改。'}</Intro>
      {/* 高度用 rows：px-input 的 min-height 不在 Tailwind 的层里，min-h-* 压不过它 */}
      <textarea className="px-input resize-y font-mono text-xs leading-5" onChange={e => setText(e.target.value)} rows={28} spellCheck={false} value={text} />
      {error && <div className="px-warning text-sm">{error}</div>}
      <div className="flex flex-wrap gap-2">
        <button
          className="px-btn px-btn-primary"
          onClick={() => {
            try {
              const next = toDraft(JSON.parse(text))
              if (!creating && next.id !== d.id) {
                setError(`id 不能改（现在是 ${d.id}）。要换 id，新建一部剧本。`)
                return
              }
              setError(undefined)
              set(next)
            } catch (err) {
              setError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
            }
          }}
          type="button"
        >
          应用到表单
        </button>
        <button className="px-btn" onClick={() => setText(JSON.stringify(fromDraft(d), null, 2))} type="button">从表单重新生成</button>
      </div>
    </>
  )
}
