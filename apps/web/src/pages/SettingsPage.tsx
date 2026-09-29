/**
 * 系统设置（外观移植自 Rpgforge 的 SYSTEM CONSOLE）：DeepSeek API Key 与新局的默认模型、推理强度。
 * Rpgforge 的管理 Token、Base URL、模型槽位分配 TaleForge 没有，不搬。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api.ts'
import { AppShell } from '../components/AppShell.tsx'
import type { CredentialStatus, ModelCatalog, ModelSelection } from '../types.ts'

export function SettingsPage({ credential, onChanged }: { credential?: CredentialStatus; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [model, setModel] = useState<ModelSelection>()
  const [groups, setGroups] = useState<ModelCatalog['groups']>([])

  useEffect(() => {
    api.globalModel().then(setModel).catch(() => undefined)
    api.modelCatalog().then(c => setGroups(c.groups)).catch(() => undefined)
  }, [])

  const envShadowed = credential && !credential.writable
  const models = groups.flatMap(g => g.models.map(m => ({ ...m, provider: g.id })))
  const current = models.find(m => m.id === model?.model)
  const efforts = current?.reasoning?.efforts ?? []

  const saveKey = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!key.trim() || busy) return
    setBusy(true)
    setMessage(undefined)
    try {
      await api.saveCredential(key.trim())
      setKey('')
      setMessage('API Key 已保存，立即生效。')
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async () => {
    setBusy(true)
    try {
      await api.clearCredential()
      setMessage('已清除保存的 API Key。')
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (patch: Partial<ModelSelection>) => {
    if (!model) return
    try {
      setModel(await api.saveGlobalModel({ ...model, ...patch }))
      setMessage('默认模型已更新，从下一局开始使用。')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <AppShell>
      <section className="px-panel px-panel-strong px-panel-pad">
        <p className="px-eyebrow">SYSTEM CONSOLE</p>
        <h1 className="px-heading mt-2 text-3xl">系统设置</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--muted)]">平台只对接 DeepSeek。Key 存在服务器的数据卷里（仅本机可读），与存档一同持久化，不会进入 Git。</p>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="grid content-start gap-5">
          <form className="px-panel px-panel-pad grid gap-4" onSubmit={saveKey}>
            <h2 className="px-heading text-base">DeepSeek API Key</h2>
            {envShadowed
              ? <div className="px-warning">当前由启动环境变量提供，这里改不动。要改用界面管理，请清空部署目录 .env 中的 DEEPSEEK_API_KEY 后重启容器。</div>
              : (
                  <>
                    <label className="grid gap-2">
                      <span className="px-label">{credential?.configured ? '替换为新的 Key' : '填入 Key'}</span>
                      <input className="px-input" autoComplete="off" onChange={e => setKey(e.target.value)} placeholder="sk-…" type="password" value={key} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button className="px-btn px-btn-primary" disabled={busy || !key.trim()} type="submit">{busy ? '保存中…' : '保存 Key'}</button>
                      {credential?.configured && <button className="px-btn px-btn-danger" disabled={busy} onClick={() => void clearKey()} type="button">清除已保存的 Key</button>}
                    </div>
                  </>
                )}
          </form>

          <section className="px-panel px-panel-pad grid gap-4">
            <div>
              <h2 className="px-heading text-base">新局的默认模型</h2>
              <p className="mt-1 text-sm leading-6 text-[color:var(--muted)]">
                Flash 快而省，Pro 更擅长长篇叙事的连贯与人物层次；推理强度越高想得越久越贵，Off 关闭思考出文最快（只影响写正文，结算本来就不思考）。单局可在游戏内临时切换。
              </p>
            </div>
            <div className="mode-switch w-fit">
              {models.map(m => (
                <button className={model?.model === m.id ? 'mode-active' : undefined} key={m.id} onClick={() => void pick({ provider: m.provider, model: m.id })} type="button">{m.name}</button>
              ))}
            </div>
            {efforts.length > 0 && (
              <div className="mode-switch w-fit">
                {efforts.map(e => (
                  <button className={model?.reasoningEffort === e.id ? 'mode-active' : undefined} key={e.id} onClick={() => void pick({ reasoningEffort: e.id })} type="button">推理 {e.name}</button>
                ))}
              </div>
            )}
          </section>
          {message && <div className="px-status">{message}</div>}
        </div>

        <aside className="px-panel px-panel-pad">
          <h2 className="px-heading text-base">当前状态</h2>
          <dl className="mt-4 grid gap-3 text-sm">
            <StatusRow label="API Key">{credential?.configured ? '已配置' : '未配置'}</StatusRow>
            <StatusRow label="Key 来源">{credential?.source === 'env' ? '启动环境变量（只读）' : credential?.configured ? '数据卷（界面写入）' : '—'}</StatusRow>
            <StatusRow label="默认模型">{current?.name ?? model?.model ?? '…'}</StatusRow>
            <StatusRow label="推理强度">{model?.reasoningEffort ?? '…'}</StatusRow>
          </dl>
        </aside>
      </div>
    </AppShell>
  )
}

function StatusRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="border-b-2 border-[color:var(--border)] pb-3 last:border-b-0">
      <dt className="px-label">{label}</dt>
      <dd className="mt-1 break-all font-medium">{children}</dd>
    </div>
  )
}
