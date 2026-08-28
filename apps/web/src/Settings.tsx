import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import type { CredentialStatus, ModelCatalog, ModelSelection } from './types.ts'

interface Props {
  status?: CredentialStatus
  onSaved: () => void
}

type ModelGroups = Pick<ModelCatalog, 'groups'>['groups']

export function Settings({ status, onSaved }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [globalModel, setGlobalModel] = useState<ModelSelection>()
  const [groups, setGroups] = useState<ModelGroups>([])

  const refreshCatalog = useCallback(() => {
    api.modelCatalog().then(c => setGroups(c.groups)).catch(() => undefined)
  }, [])

  useEffect(() => {
    setSaved(false)
  }, [status?.configured])

  useEffect(() => {
    api.globalModel().then(setGlobalModel).catch(() => undefined)
    refreshCatalog()
  }, [refreshCatalog])

  const pickModel = async (patch: Partial<ModelSelection>) => {
    if (!globalModel) return
    try {
      setGlobalModel(await api.saveGlobalModel({ ...globalModel, ...patch }))
    } catch (err) {
      setError(String(err))
    }
  }

  const save = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.saveCredential(value)
      setValue('')
      setSaved(true)
      onSaved()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await api.clearCredential()
      setSaved(false)
      onSaved()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const envShadowed = status && !status.writable
  const currentGroup = groups.find(g => g.id === globalModel?.provider)
  const currentModel = currentGroup?.models.find(m => m.id === globalModel?.model)
  const efforts = currentModel?.reasoning?.efforts ?? []

  return (
    <div className="settings">
      <section>
        <h3>DeepSeek API Key</h3>
        {status?.configured
          ? (
              <p className="state ok">
                已配置{status.source === 'env' ? '（来自启动环境变量）' : '（保存在服务器数据卷中）'}
              </p>
            )
          : <p className="state warn">尚未配置，填入后即可开始游戏</p>}

        {envShadowed
          ? (
              <p className="hint">
                当前由启动环境变量提供，本界面无法修改。要改用界面管理，请清空部署目录 .env 中的
                DEEPSEEK_API_KEY 后重启容器。
              </p>
            )
          : (
              <>
                <div className="key-row">
                  <input
                    type="password"
                    value={value}
                    placeholder="sk-…"
                    autoComplete="off"
                    onChange={e => setValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && value.trim() && !busy) void save()
                    }}
                  />
                  <button onClick={() => void save()} disabled={!value.trim() || busy}>
                    {busy ? '保存中…' : '保存'}
                  </button>
                </div>
                <p className="hint">
                  保存后立即生效，无需重启。Key 写入服务器的 dsh 数据卷（.credentials.yaml），
                  与存档一同持久化，不会进入 Git。
                </p>
                {status?.configured && (
                  <button className="link danger" onClick={() => void clear()} disabled={busy}>
                    清除已保存的 Key
                  </button>
                )}
              </>
            )}

        {saved && <p className="state ok">已保存</p>}
        {error && <p className="state err">{error}</p>}
      </section>

      <section>
        <h3>默认模型</h3>
        <p className="state">
          新开的游戏使用：
          <b>{currentModel?.name ?? globalModel?.model ?? '…'}</b>
          {globalModel?.reasoningEffort ? ` · 推理 ${globalModel.reasoningEffort}` : ''}
        </p>
        {groups.map(group => (
          <div key={group.id}>
            {groups.length > 1 && <p className="hint" style={{ marginBottom: 4 }}>{group.name}</p>}
            <div className="pick-list">
              {group.models.map(m => (
                <button
                  key={`${group.id}/${m.id}`}
                  className={`pick${globalModel?.provider === group.id && globalModel?.model === m.id ? ' on' : ''}`}
                  onClick={() => void pickModel({ provider: group.id, model: m.id })}
                >
                  {m.name}
                </button>
              ))}
            </div>
          </div>
        ))}
        {efforts.length > 0 && (
          <div className="pick-list" style={{ marginTop: 8 }}>
            {efforts.map(e => (
              <button
                key={e.id}
                className={`pick${globalModel?.reasoningEffort === e.id ? ' on' : ''}`}
                onClick={() => void pickModel({ reasoningEffort: e.id })}
              >
                推理 {e.id}
              </button>
            ))}
          </div>
        )}
        <p className="hint">
          Flash 快而省，Pro 更擅长长篇叙事的连贯与人物层次；推理强度越高想得越久越贵，
          Off 关闭思考模式出文最快。单局可在游戏内临时切换，不影响这里的默认。
        </p>
      </section>
    </div>
  )
}
