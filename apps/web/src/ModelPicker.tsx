/** 本局模型选择。切换只影响当前存档——BFF 会把部署默认还原。 */
import { useState } from 'react'
import type { ModelCatalog, ModelSelection } from './types.ts'

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
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="modal">
        <h2>本局模型</h2>

        <h3>模型</h3>
        <div className="pick-list">
          {models.map(m => (
            <button
              key={m.id}
              className={`pick${m.id === model ? ' on' : ''}`}
              onClick={() => setModel(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>

        {efforts.length > 0 && (
          <>
            <h3>推理强度</h3>
            <div className="pick-list">
              {efforts.map(e => (
                <button
                  key={e.id}
                  className={`pick${e.id === effort ? ' on' : ''}`}
                  onClick={() => setEffort(e.id)}
                >
                  {e.name}
                </button>
              ))}
            </div>
            <p className="hint">
              强度越高想得越久、越贵；Off 关闭思考模式，出文最快。
            </p>
          </>
        )}

        <p className="hint">
          只改这一局，不影响以后新开的游戏。中途换模型会让上下文缓存失效，该回合成本偏高。
        </p>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button onClick={() => void apply()} disabled={busy}>{busy ? '切换中…' : '应用'}</button>
        </div>
      </div>
    </>
  )
}
