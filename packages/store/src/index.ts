/**
 * 会话存储：每个会话一个 JSONL 事件日志。状态一律由日志折叠出来，这里不存任何派生值。
 *
 * - 追加：一行一个事件，O_APPEND 写入；读的时候容忍最后一行写了一半（进程被杀）。
 * - 重写（截断/恢复）：先写临时文件再 rename，任何时刻磁盘上都是一份完整日志。
 * - fork = 截断后复制；存档 = 复制文件；读档 = 拷回来。
 *
 * 目录（都在数据卷里）：
 *   sessions/<id>.jsonl    进行中的会话（游戏、工坊、修改对话）
 *   archive/<id>__<时间>.jsonl  被单存档顶掉的旧局、重写前的原稿——只归档不删，是对照语料
 *   backups/<时间>__<id>.jsonl + .meta.json  玩家手动存档
 */
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export interface StoredEvent<T = Record<string, unknown>> {
  type: string
  seq: number
  time: number
  data: T
}

export interface SessionListing {
  id: string
  /** 最后写入时间（文件 mtime） */
  updatedAt: number
  /** 第一条事件 session/created 的载荷 */
  created: Record<string, unknown>
}

export interface BackupMeta {
  name: string
  sessionId: string
  backedAt: number
  title?: string
  storyId?: string
  turns?: number
}

const SESSION_ID = /^s-[0-9]{14}-[a-z0-9]{6}$/
export const BACKUP_NAME = /^[0-9TZ-]+__s-[0-9]{14}-[a-z0-9]{6}$/

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id)
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function newSessionId(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const t = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  return `s-${t}-${randomBytes(4).toString('hex').slice(0, 6)}`
}

/** 解析日志文本；最后一行不完整（写到一半进程没了）就丢掉它，其余照常。 */
export function parseLog(text: string): StoredEvent[] {
  const out: StoredEvent[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as StoredEvent)
    } catch (err) {
      if (i >= lines.length - 2) break // 残缺尾行
      throw new Error(`日志第 ${i + 1} 行损坏：${String(err)}`)
    }
  }
  return out
}

/** 只读到第一个换行：列会话时要的只是 session/created，而它带着整份剧本快照、后面还有整局日志。 */
function readFirstLine(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(64 * 1024)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      const nl = buf.subarray(0, n).indexOf(10)
      if (nl >= 0) {
        chunks.push(Buffer.from(buf.subarray(0, nl)))
        break
      }
      chunks.push(Buffer.from(buf.subarray(0, n)))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export class SessionStore {
  readonly root: string
  private readonly sessionsDir: string
  private readonly archiveDir: string
  private readonly backupsDir: string
  /** 每个会话的 seq 水位：事件与流式增量共用一条单调序列（增量不落盘，序号照样占用） */
  private readonly seqs = new Map<string, number>()

  constructor(root: string) {
    this.root = root
    this.sessionsDir = path.join(root, 'sessions')
    this.archiveDir = path.join(root, 'archive')
    this.backupsDir = path.join(root, 'backups')
    for (const dir of [this.sessionsDir, this.archiveDir, this.backupsDir]) mkdirSync(dir, { recursive: true })
  }

  private file(id: string): string {
    if (!isSessionId(id)) throw new Error(`非法会话 id：${id}`)
    return path.join(this.sessionsDir, `${id}.jsonl`)
  }

  exists(id: string): boolean {
    return isSessionId(id) && existsSync(this.file(id))
  }

  /** 建会话：第一条事件固定是 session/created。 */
  create(created: Record<string, unknown>): string {
    const id = newSessionId()
    writeFileSync(this.file(id), '')
    this.seqs.set(id, 0)
    this.append(id, 'session/created', created)
    return id
  }

  read(id: string): StoredEvent[] {
    const file = this.file(id)
    if (!existsSync(file)) throw new Error(`会话不存在：${id}`)
    return parseLog(readFileSync(file, 'utf8'))
  }

  /** 分配下一个序号（事件与流式增量共用）。 */
  nextSeq(id: string): number {
    let last = this.seqs.get(id)
    if (last === undefined) {
      const events = this.read(id)
      last = events.length ? events[events.length - 1].seq : 0
    }
    const next = last + 1
    this.seqs.set(id, next)
    return next
  }

  append<T extends Record<string, unknown>>(id: string, type: string, data: T): StoredEvent<T> {
    const event: StoredEvent<T> = { type, seq: this.nextSeq(id), time: Date.now(), data }
    appendFileSync(this.file(id), `${JSON.stringify(event)}\n`)
    return event
  }

  list(): SessionListing[] {
    const out: SessionListing[] = []
    for (const name of readdirSync(this.sessionsDir)) {
      if (!name.endsWith('.jsonl')) continue
      const id = name.slice(0, -'.jsonl'.length)
      if (!isSessionId(id)) continue
      const file = path.join(this.sessionsDir, name)
      try {
        const created = (JSON.parse(readFirstLine(file)) as StoredEvent).data
        out.push({ id, updatedAt: statSync(file).mtimeMs, created })
      } catch {
        // 连第一行都读不出来的残文件不列出，也不删——留给人看
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 把会话挪进 archive/（单存档顶掉旧局用）。只挪不删。 */
  archive(id: string): void {
    const from = this.file(id)
    if (!existsSync(from)) return
    renameSync(from, path.join(this.archiveDir, `${id}__${stamp()}.jsonl`))
    this.seqs.delete(id)
  }

  /** 彻底删除（玩家在详情页明确删除会话、删剧本级联时用）。 */
  remove(id: string): void {
    rmSync(this.file(id), { force: true })
    this.seqs.delete(id)
  }

  /**
   * 截断：只保留 seq < beforeSeq 的事件（重写上一回合用）。原稿先整份复制进 archive/，
   * 被弃掉的那一章不会凭空消失。seq 水位不回退——已经发给界面的序号不能再发一次。
   */
  truncate(id: string, beforeSeq: number): StoredEvent[] {
    const file = this.file(id)
    copyFileSync(file, path.join(this.archiveDir, `${id}__${stamp()}__rewrite.jsonl`))
    const kept = this.read(id).filter(e => e.seq < beforeSeq)
    writeAtomic(file, kept.map(e => `${JSON.stringify(e)}\n`).join(''))
    return kept
  }

  // ---- 存档 ----

  backup(id: string, meta: Omit<BackupMeta, 'name' | 'sessionId' | 'backedAt'>): BackupMeta {
    const name = `${stamp()}__${id}`
    copyFileSync(this.file(id), path.join(this.backupsDir, `${name}.jsonl`))
    const full: BackupMeta = { name, sessionId: id, backedAt: Date.now(), ...meta }
    writeFileSync(path.join(this.backupsDir, `${name}.meta.json`), JSON.stringify(full))
    return full
  }

  listBackups(): BackupMeta[] {
    const out: BackupMeta[] = []
    for (const f of readdirSync(this.backupsDir)) {
      if (!f.endsWith('.jsonl')) continue
      const name = f.slice(0, -'.jsonl'.length)
      if (!BACKUP_NAME.test(name)) continue
      try {
        out.push(JSON.parse(readFileSync(path.join(this.backupsDir, `${name}.meta.json`), 'utf8')) as BackupMeta)
      } catch {
        out.push({ name, sessionId: name.split('__')[1] ?? '', backedAt: 0 })
      }
    }
    return out.sort((a, b) => b.backedAt - a.backedAt)
  }

  /** 读档：快照拷回原会话 id（原位覆盖，原子）。返回会话 id。 */
  restore(name: string): string {
    if (!BACKUP_NAME.test(name)) throw new Error(`存档不存在：${name}`)
    const src = path.join(this.backupsDir, `${name}.jsonl`)
    if (!existsSync(src)) throw new Error(`存档不存在：${name}`)
    const id = name.split('__')[1]
    writeAtomic(this.file(id), readFileSync(src, 'utf8'))
    this.seqs.delete(id)
    return id
  }

  removeBackup(name: string): void {
    if (!BACKUP_NAME.test(name)) return
    rmSync(path.join(this.backupsDir, `${name}.jsonl`), { force: true })
    rmSync(path.join(this.backupsDir, `${name}.meta.json`), { force: true })
  }
}
