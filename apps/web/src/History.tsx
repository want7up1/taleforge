/** 回顾页：完整对局记录。游玩屏只渲染最新一回合，往前翻到这里来。 */
import { useEffect, useState } from 'react'
import { api } from './api.ts'
import { foldHistory } from './fold.ts'
import { StoryMarkdown } from './StoryMarkdown.tsx'
import { parseTurn } from './turn.ts'
import type { ChatMessage, StoryDetail } from './types.ts'

interface Props {
  sessionId: string
  story?: StoryDetail
  onBack: () => void
  onFork: (atSeq: number) => void
}

export function History({ sessionId, story, onBack, onFork }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => {
    api.history(sessionId)
      .then(({ events }) => setMessages(foldHistory(events)))
      .catch(err => setError(String(err)))
  }, [sessionId])

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">TALEFORGE</span>
        <div className="crumbs">
          <b>回顾</b>
          {story && <span>{story.title}</span>}
        </div>
        <div className="tools">
          <button onClick={onBack}>← 返回游戏</button>
        </div>
      </header>

      <div className="scroll">
        <div className="column">
          {messages.map((m, i) => {
            if (m.role === 'user') {
              return (
                <div key={m.seq ?? i} className="player-block">
                  <span className="label">你</span>
                  <p>{m.text}</p>
                </div>
              )
            }
            const { narrative } = parseTurn(m.text)
            return (
              <div key={m.seq ?? i} className="gm-block">
                <span className="label">GM</span>
                <StoryMarkdown text={narrative} characters={story?.cast.map(c => c.name) ?? []} />
                {typeof m.seq === 'number' && (
                  <button className="ghost fork" onClick={() => onFork(m.seq!)}>
                    ⑂ 从此处开分支
                  </button>
                )}
              </div>
            )
          })}
          {messages.length === 0 && !error && <p className="dim">还没有记录。</p>}
          {error && <div className="error">{error}</div>}
        </div>
      </div>
    </div>
  )
}
