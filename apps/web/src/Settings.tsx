import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import type { CredentialStatus, ModelCatalog, ModelSelection, SubscriptionStatus } from './types.ts'

interface Props {
  status?: CredentialStatus
  onSaved: () => void
}

type ModelGroups = Pick<ModelCatalog, 'groups'>['groups']

/** 到期时间只用来告诉玩家"还在有效期内"，插件会自动续期，不需要精确到分钟。 */
function expiryText(at?: number): string {
  if (!at) return ''
  const left = at - Date.now()
  if (left <= 0) return '（登录态已过期，会在下次调用时自动续期）'
  const hours = Math.round(left / 3600_000)
  return hours >= 1 ? `（有效期约 ${hours} 小时，到期自动续）` : '（即将自动续期）'
}

export function Settings({ status, onSaved }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [globalModel, setGlobalModel] = useState<ModelSelection>()
  const [groups, setGroups] = useState<ModelGroups>([])

  const [sub, setSub] = useState<SubscriptionStatus>()
  const [authUrl, setAuthUrl] = useState<string>()
  const [pasted, setPasted] = useState('')
  const [subBusy, setSubBusy] = useState(false)
  const [subError, setSubError] = useState<string>()

  const refreshCatalog = useCallback(() => {
    api.modelCatalog().then(c => setGroups(c.groups)).catch(() => undefined)
  }, [])

  const refreshSub = useCallback(() => {
    api.subscription().then(setSub).catch(() => setSub({ available: false }))
  }, [])

  useEffect(() => {
    setSaved(false)
  }, [status?.configured])

  useEffect(() => {
    api.globalModel().then(setGlobalModel).catch(() => undefined)
    refreshCatalog()
    refreshSub()
  }, [refreshCatalog, refreshSub])

  // 登录尝试挂起期间轮询：回调直接打到本机时无需粘贴，这里能自动收敛到已登录。
  useEffect(() => {
    if (!sub?.busy) return
    const timer = setInterval(refreshSub, 2000)
    return () => clearInterval(timer)
  }, [sub?.busy, refreshSub])

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

  const startLogin = async () => {
    setSubBusy(true)
    setSubError(undefined)
    try {
      const { authorizeUrl } = await api.subscriptionLogin()
      setAuthUrl(authorizeUrl)
      window.open(authorizeUrl, '_blank', 'noopener')
      refreshSub()
    } catch (err) {
      setSubError(String(err))
    } finally {
      setSubBusy(false)
    }
  }

  const finishLogin = async () => {
    setSubBusy(true)
    setSubError(undefined)
    try {
      await api.subscriptionManual(pasted.trim())
      setPasted('')
      setAuthUrl(undefined)
      refreshSub()
      refreshCatalog()
    } catch (err) {
      setSubError(String(err))
    } finally {
      setSubBusy(false)
    }
  }

  const cancelLogin = async () => {
    setSubBusy(true)
    try {
      await api.subscriptionCancel()
      setAuthUrl(undefined)
      setPasted('')
      refreshSub()
    } catch (err) {
      setSubError(String(err))
    } finally {
      setSubBusy(false)
    }
  }

  const logout = async () => {
    setSubBusy(true)
    setSubError(undefined)
    try {
      await api.subscriptionLogout()
      refreshSub()
      refreshCatalog()
    } catch (err) {
      setSubError(String(err))
    } finally {
      setSubBusy(false)
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

      {sub?.available && (
        <section>
          <h3>Grok 订阅</h3>
          {sub.loggedIn
            ? (
                <>
                  <p className="state ok">
                    已登录{sub.account ? ` · ${sub.account}` : ''}
                    {sub.detail ? ` · ${sub.detail}` : ''}
                  </p>
                  <p className="hint">
                    用 SuperGrok / X Premium 订阅额度跑游戏，不消耗 API Key 余额。
                    登录态存在服务器数据卷里，会自动续期{expiryText(sub.expiresAt)}。
                    下面的「默认模型」里已经能选 Grok。
                  </p>
                  <button className="link danger" onClick={() => void logout()} disabled={subBusy}>
                    退出 Grok 登录
                  </button>
                </>
              )
            : (
                <>
                  <p className="state warn">未登录</p>
                  {/* 未登录时 detail 带的是上一次登录失败的原因（如授权码无效），要让玩家看见 */}
                  {sub.detail && <p className="state err">{sub.detail}</p>}
                  {!authUrl && !sub.busy && (
                    <>
                      <button onClick={() => void startLogin()} disabled={subBusy}>
                        {subBusy ? '准备中…' : '用 SuperGrok / X Premium 登录'}
                      </button>
                      <p className="hint">
                        需要有 API 权限的 X 订阅。点击后会打开 xAI 授权页，授权完成即可回到这里。
                      </p>
                    </>
                  )}
                  {(authUrl || sub.busy) && (
                    <>
                      <p className="hint">
                        1. 在打开的授权页完成授权
                        {authUrl && (
                          <>
                            {' '}
                            （没弹出就点
                            <a href={authUrl} target="_blank" rel="noopener noreferrer">这个链接</a>
                            ）
                          </>
                        )}
                        <br />
                        2. 授权后浏览器会跳到一个 <b>127.0.0.1:56121</b> 的地址。如果它能正常打开，
                        这里会自动变成已登录；如果打不开（服务器在远端时就会这样），
                        把浏览器地址栏里那条完整 URL 复制到下面。
                      </p>
                      <div className="key-row">
                        <input
                          type="text"
                          value={pasted}
                          placeholder="粘贴回调 URL 或授权码"
                          autoComplete="off"
                          onChange={e => setPasted(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && pasted.trim() && !subBusy) void finishLogin()
                          }}
                        />
                        <button onClick={() => void finishLogin()} disabled={!pasted.trim() || subBusy}>
                          完成登录
                        </button>
                      </div>
                      <button className="link danger" onClick={() => void cancelLogin()} disabled={subBusy}>
                        取消
                      </button>
                    </>
                  )}
                </>
              )}
          {subError && <p className="state err">{subError}</p>}
        </section>
      )}

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
