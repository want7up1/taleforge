/** 本局模型选择。只改这一局（写一条 model/selected 事件），不动全局默认。 */
import { useState } from 'react'
import type { ModelCatalog, ModelSelection } from '../types.ts'

interface Props {
  catalog: ModelCatalog
  onPick: (selection: ModelSelection) => Promise<void>
  onClose: () => void
}

export function ModelPicker({ catalog, onPick, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState(catalog.current.model)
  const [effort, setEffort] = useState(catalog.current.reasoningEffort ?? 'high')
  const models = catalog.groups.flatMap(g => g.models.map(m => ({ ...m, provider: g.id })))
  const chosen = models.find(m => m.id === model)
  const efforts = chosen?.reasoning?.efforts ?? []

  const apply = async () => {
    if (!chosen) return
    setBusy(true)
    try {
      await onPick({ provider: chosen.provider, model, reasoningEffort: effort })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div aria-modal="true" className="px-modal-overlay" role="dialog" aria-label="本局模型">
      <button aria-label="关闭" className="absolute inset-0 cursor-default" onClick={onClose} type="button" />
      <div className="px-modal max-w-md">
        <p className="px-eyebrow">MODEL</p>
        <h2 className="px-heading mt-2 text-lg">本局模型</h2>
        <p className="px-label mt-4">模型</p>
        <div className="pick-list mt-2">
          {models.map(m => (
            <button key={m.id} className={`pick${m.id === model ? ' on' : ''}`} onClick={() => setModel(m.id)} type="button">{m.name}</button>
          ))}
        </div>
        {efforts.length > 0 && (
          <>
            <p className="px-label mt-4">推理强度</p>
            <div className="pick-list mt-2">
              {efforts.map(e => (
                <button key={e.id} className={`pick${e.id === effort ? ' on' : ''}`} onClick={() => setEffort(e.id)} type="button">{e.name}</button>
              ))}
            </div>
          </>
        )}
        <p className="mt-4 text-xs leading-5 text-[color:var(--muted)]">
          只改这一局，不影响以后新开的游戏。强度越高想得越久、越贵；Off 关闭思考，出文最快（结算本来就不思考）。中途换模型会让上下文缓存失效，该回合成本偏高。
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className="px-btn" onClick={onClose} type="button">取消</button>
          <button className="px-btn px-btn-primary" onClick={() => void apply()} disabled={busy} type="button">{busy ? '切换中…' : '应用'}</button>
        </div>
      </div>
    </div>
  )
}
