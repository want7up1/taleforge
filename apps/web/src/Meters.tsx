/** 资源条的两种呈现：顶栏精简（只放主角自己的）与卷宗里的完整清单；外加等级条。 */
import type { MechanicsSnapshot, ProgressionSnapshot, ResourceDef, ResourceValue } from './types.ts'

/** 等级进度：本级起点到下一级阈值之间走了多少 */
export function levelPct(p: ProgressionSnapshot): number {
  if (p.next === null) return 100
  const span = p.next - p.prev
  // 经验被扣到本级起点以下时（等级不降）条子归零，不画负宽度
  return span > 0 ? Math.min(100, Math.max(0, Math.round(((p.xp - p.prev) / span) * 100))) : 0
}

/** 顶栏等级条：Lv + 经验进度；有未分配点时亮出来，点一下开卷宗加点 */
export function LevelStrip({ progression, onClick }: { progression: ProgressionSnapshot; onClick: () => void }) {
  const p = progression
  const title = `Lv.${p.level} · ${p.label} ${p.xp}${p.next !== null ? `/${p.next}` : '（满级）'}${p.unspent > 0 ? ` · 未分配 ${p.unspent} 点` : ''}`
  return (
    <button className={`level-strip${p.unspent > 0 ? ' attention' : ''}`} onClick={onClick} title={title}>
      <span className="strip-label">Lv.{p.level}</span>
      <span className="strip-track"><i style={{ width: `${levelPct(p)}%` }} /></span>
      <span className="strip-value">{p.next !== null ? `${p.xp}/${p.next}` : '满'}</span>
      {p.unspent > 0 && <span className="level-badge">+{p.unspent}</span>}
    </button>
  )
}

function pct(def: ResourceDef, value: number): number {
  const span = def.max - def.min
  return span > 0 ? Math.round(((value - def.min) / span) * 100) : 0
}

function Bar({ def, cell }: { def: ResourceDef; cell: ResourceValue }) {
  const filled = pct(def, cell.value)
  return (
    <div className={`meter g-${def.group}`}>
      <div className="meter-head">
        <span className="meter-label">{def.label}</span>
        <span className="meter-value">{cell.value}</span>
      </div>
      <div className="meter-track"><i style={{ width: `${filled}%` }} /></div>
      {cell.last && (
        <div className="meter-last">
          <b>{cell.last.applied > 0 ? `+${cell.last.applied}` : cell.last.applied}</b>
          {' '}
          {cell.last.reason}
        </div>
      )}
    </div>
  )
}

/** 显示位置：剧本可选位（strip/panel/hidden）；缺省 self 组进顶栏，其余进面板 */
export function placementOf(def: ResourceDef): 'strip' | 'panel' | 'hidden' {
  return def.display ?? (def.group === 'self' ? 'strip' : 'panel')
}

/** 防剧透：绑定了 revealWith 的资源，人物出场前不可见 */
export function revealed(def: ResourceDef, knownCast?: Set<string>): boolean {
  return !def.revealWith || !knownCast || knownCast.has(def.revealWith)
}

/** 顶栏一行：剧本选定常驻的数值，玩家每回合决策的依据 */
export function MeterStrip({ snapshot, knownCast }: { snapshot: MechanicsSnapshot; knownCast?: Set<string> }) {
  const own = snapshot.defs.filter(d => placementOf(d) === 'strip' && revealed(d, knownCast))
  if (own.length === 0) return null
  return (
    <div className="meter-strip">
      {own.map((def) => {
        const cell = snapshot.state[def.id]
        if (!cell) return null
        return (
          <span key={def.id} className="strip-item" title={`${def.label} ${cell.value}/${def.max}`}>
            <span className="strip-label">{def.label}</span>
            <span className="strip-track"><i style={{ width: `${pct(def, cell.value)}%` }} /></span>
            <span className="strip-value">{cell.value}</span>
          </span>
        )
      })}
    </div>
  )
}

const GROUP_TITLE: Record<ResourceDef['group'], string> = {
  self: '你',
  affinity: '她们',
  world: '世界',
}

export function MeterPanel({ snapshot, knownCast }: { snapshot: MechanicsSnapshot; knownCast?: Set<string> }) {
  return (
    <>
      {(['self', 'affinity', 'world'] as const).map((group) => {
        const defs = snapshot.defs.filter(d =>
          d.group === group && placementOf(d) !== 'hidden' && revealed(d, knownCast))
        if (defs.length === 0) return null
        return (
          <section key={group}>
            <h3>{snapshot.groups?.[group] ?? GROUP_TITLE[group]}</h3>
            {defs.map((def) => {
              const cell = snapshot.state[def.id]
              return cell ? <Bar key={def.id} def={def} cell={cell} /> : null
            })}
          </section>
        )
      })}
    </>
  )
}
