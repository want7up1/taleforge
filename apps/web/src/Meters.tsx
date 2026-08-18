/** 资源条的两种呈现：顶栏精简（只放主角自己的）与卷宗里的完整清单。 */
import type { MechanicsSnapshot, ResourceDef, ResourceValue } from './types.ts'

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

/** 顶栏一行：只放主角自身的状态，那是每回合决策的依据 */
export function MeterStrip({ snapshot }: { snapshot: MechanicsSnapshot }) {
  const own = snapshot.defs.filter(d => d.group === 'self')
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
  world: '据点',
}

export function MeterPanel({ snapshot }: { snapshot: MechanicsSnapshot }) {
  return (
    <>
      {(['self', 'affinity', 'world'] as const).map((group) => {
        const defs = snapshot.defs.filter(d => d.group === group)
        if (defs.length === 0) return null
        return (
          <section key={group}>
            <h3>{GROUP_TITLE[group]}</h3>
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
