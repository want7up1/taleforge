import { useEffect, useState } from 'react'
import { api } from './api.ts'
import type { CredentialStatus } from './types.ts'

interface Props {
  status?: CredentialStatus
  onSaved: () => void
  onClose?: () => void
}

export function Settings({ status, onSaved, onClose }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setSaved(false)
  }, [status?.configured])

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

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>设置</h2>
        {onClose && <button className="link" onClick={onClose}>返回</button>}
      </div>

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
    </div>
  )
}
