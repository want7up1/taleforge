/** 唤起 GM 修改剧本：每部剧本各自常驻一个修改对话（改剧本的唯一入口）。 */
import { useState } from 'react'
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { ChatView } from '../components/ChatView.tsx'
import { usePixelDialog } from '../components/PixelDialog.tsx'
import { Link } from '../router.tsx'
import { ErrorCard, useLoad } from './common.tsx'

export function EditPage({ scenarioId }: { scenarioId: string }) {
  const dialog = usePixelDialog()
  const [state, , setData] = useLoad(async () => {
    const [story, session] = await Promise.all([api.scenario(scenarioId), api.editSession(scenarioId)])
    return { story, sessionId: session.sessionId }
  }, [scenarioId])
  const [error, setError] = useState<string>()

  if (state.status !== 'ready') {
    return <AppShell>{state.status === 'loading' ? <Loading text="正在唤醒 GM…" /> : <ErrorCard message={state.message} />}</AppShell>
  }
  const { story, sessionId } = state.data

  const reset = async () => {
    if (!(await dialog.confirm('重开会丢弃这段修改对话（已发布的修改不受影响），确定吗？', { danger: true, confirmLabel: '重开' }))) return
    try {
      const r = await api.editSessionReset(scenarioId)
      setData({ story, sessionId: r.sessionId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <AppShell>
      <section className="px-panel px-panel-strong px-panel-pad">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0">
            <p className="px-eyebrow">REVISE · 修改剧本</p>
            <h1 className="px-heading mt-2 text-2xl">{story.title}</h1>
            <p className="mt-2 text-sm leading-6 text-[color:var(--muted)]">
              告诉 GM 要改哪里。它会读取现行正式版、把改动列给你确认，再同 id 发布（旧版自动留档，可在剧本详情页回滚）。
            </p>
          </div>
          <div className="grid w-full gap-2 sm:w-fit">
            <Link className="px-btn" href={`/library/${scenarioId}`}>◂ 返回剧本</Link>
            <button className="px-btn" onClick={() => void reset()} type="button">↺ 重开对话</button>
          </div>
        </div>
      </section>
      {error && <section className="px-alert">{error}</section>}
      <ChatView
        sessionId={sessionId}
        opening={`我要修改剧本《${story.title}》（id：${story.id}）。请先用工具读取它的现行正式版，简要确认核心设定，然后等我说要改哪里；发布前把变更点列给我确认。`}
        agentLabel="GM"
        placeholder="说说这个剧本要改哪里"
      />
    </AppShell>
  )
}
