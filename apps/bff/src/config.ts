/**
 * 平台设置与凭据：都住数据卷（<数据根>/v2/），随卷持久化、改了立即生效。
 *
 * API Key 两层：环境变量 DEEPSEEK_API_KEY 是只读层——一旦有非空值就遮蔽写入通道，
 * 设置页变成只读（writable: false）；否则读写 credentials.json（权限 0600，不进 Git）。
 * 升级自 dsh 版本时，旧的 .credentials.yaml 与 settings.yaml 各导入一次。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Effort, EngineSettings } from '@taleforge/engine'
import { parse } from 'yaml'

export const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
] as const

export const EFFORTS: { id: Effort; name: string }[] = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

/** dsh 时代的模型名 → 现行名（deepseek-v4-flash 已退役，由 V4.1-Flash 按 Flash 价格接管） */
const LEGACY_MODEL: Record<string, string> = { 'deepseek-v4-flash': 'deepseek-flash' }

export const DEFAULT_SETTINGS: EngineSettings = {
  model: 'deepseek-flash',
  effort: 'high',
  recentChapters: 5,
  recapEvery: 4,
}

const isEffort = (v: unknown): v is Effort => EFFORTS.some(e => e.id === v)
const isModel = (v: unknown): v is string => MODELS.some(m => m.id === v)

function writeJson(file: string, value: unknown, mode?: number): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), mode !== undefined ? { mode } : undefined)
  renameSync(tmp, file)
  if (mode !== undefined) chmodSync(file, mode)
}

export class PlatformConfig {
  private readonly dir: string
  private readonly settingsFile: string
  private readonly credentialsFile: string
  private readonly env: NodeJS.ProcessEnv

  constructor(dataHome: string, env: NodeJS.ProcessEnv = process.env) {
    this.dir = path.join(dataHome, 'v2')
    mkdirSync(this.dir, { recursive: true })
    this.settingsFile = path.join(this.dir, 'settings.json')
    this.credentialsFile = path.join(this.dir, 'credentials.json')
    this.env = env
    this.importLegacy(dataHome)
  }

  /** 从 dsh 数据目录一次性导入：只在新文件还不存在时做，导入后不再碰旧文件。 */
  private importLegacy(dataHome: string): void {
    const legacyCreds = path.join(dataHome, '.credentials.yaml')
    if (!existsSync(this.credentialsFile) && existsSync(legacyCreds)) {
      try {
        const key = (parse(readFileSync(legacyCreds, 'utf8')) as Record<string, unknown> | null)?.DEEPSEEK_API_KEY
        if (typeof key === 'string' && key.trim()) {
          writeJson(this.credentialsFile, { deepseekApiKey: key.trim() }, 0o600)
          console.log('[config] 已从旧的 .credentials.yaml 导入 API Key')
        }
      } catch (err) {
        console.warn('[config] 旧凭据文件读不了，跳过导入：', String(err))
      }
    }
    const legacySettings = path.join(dataHome, 'settings.yaml')
    if (!existsSync(this.settingsFile) && existsSync(legacySettings)) {
      try {
        const doc = parse(readFileSync(legacySettings, 'utf8')) as Record<string, { model?: string; reasoningEffort?: string }> | null
        const old = doc?.['agent-default-model']
        const model = old?.model ? LEGACY_MODEL[old.model] ?? old.model : undefined
        this.saveSettings({
          ...isModel(model) ? { model } : {},
          ...isEffort(old?.reasoningEffort) ? { effort: old.reasoningEffort } : {},
        })
      } catch {
        // 读不了就用缺省
      }
    }
  }

  settings(): EngineSettings {
    let raw: Partial<EngineSettings> = {}
    try {
      raw = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<EngineSettings>
    } catch {
      // 没有文件就用缺省
    }
    const model = raw.model ? LEGACY_MODEL[raw.model] ?? raw.model : undefined
    return {
      model: isModel(model) ? model : DEFAULT_SETTINGS.model,
      effort: isEffort(raw.effort) ? raw.effort : DEFAULT_SETTINGS.effort,
      recentChapters: Number.isInteger(raw.recentChapters) && raw.recentChapters! > 0 ? raw.recentChapters! : DEFAULT_SETTINGS.recentChapters,
      recapEvery: Number.isInteger(raw.recapEvery) && raw.recapEvery! > 0 ? raw.recapEvery! : DEFAULT_SETTINGS.recapEvery,
    }
  }

  saveSettings(patch: Partial<EngineSettings>): EngineSettings {
    const next = { ...this.settings(), ...patch }
    if (!isModel(next.model)) throw new Error(`不支持的模型：${next.model}`)
    if (!isEffort(next.effort)) throw new Error(`不支持的推理强度：${String(next.effort)}`)
    writeJson(this.settingsFile, next)
    return next
  }

  apiKey(): string | undefined {
    const env = this.env.DEEPSEEK_API_KEY?.trim()
    if (env) return env
    try {
      const key = (JSON.parse(readFileSync(this.credentialsFile, 'utf8')) as { deepseekApiKey?: string }).deepseekApiKey
      return key?.trim() || undefined
    } catch {
      return undefined
    }
  }

  credentialStatus(): { configured: boolean; source?: 'env' | 'file'; writable: boolean } {
    if (this.env.DEEPSEEK_API_KEY?.trim()) return { configured: true, source: 'env', writable: false }
    return this.apiKey() ? { configured: true, source: 'file', writable: true } : { configured: false, writable: true }
  }

  saveApiKey(key: string): void {
    writeJson(this.credentialsFile, { deepseekApiKey: key.trim() }, 0o600)
  }

  clearApiKey(): void {
    rmSync(this.credentialsFile, { force: true })
  }
}
