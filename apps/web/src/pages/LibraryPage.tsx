/** 剧本库（Rpgforge 外观）：已上架的剧本，点进详情开局、修改、导出、回滚。 */
import { api } from '../api.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { Link } from '../router.tsx'
import { EmptyText, ErrorCard, useLoad } from './common.tsx'

export function LibraryPage() {
  const [state] = useLoad(() => api.listScenarios().then(r => r.items), [])
  return (
    <AppShell>
      <section className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <p className="px-eyebrow">SCRIPT LIBRARY</p>
          <h1 className="px-heading mt-2 text-3xl sm:text-4xl">剧本库</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[color:var(--muted)]">每部剧本永远只有一个现行正式版；覆盖发布自动留档最近 10 版，可在详情页回滚。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a className="px-btn" href="/app/authoring-guide">⇩ 创作说明书</a>
          <Link className="px-btn px-btn-primary" href="/games/new">＋ 写 / 导入剧本</Link>
        </div>
      </section>
      {state.status === 'loading'
        ? <Loading text="正在读取剧本库…" />
        : state.status === 'error'
          ? <ErrorCard message={state.message} />
          : state.data.length === 0
            ? <EmptyText>剧本库还是空的——去创造炉写一部或导入一部。</EmptyText>
            : (
                <section className="grid gap-3 md:grid-cols-2">
                  {state.data.map((sc, i) => (
                    <Link className="save-slot" href={`/library/${sc.id}`} key={sc.id}>
                      <span className="save-slot-index">SCRIPT {i + 1}</span>
                      <strong className="pr-20 text-lg">{sc.name}</strong>
                      {sc.description && <span className="text-sm leading-6 text-[color:var(--muted)]">{sc.description}</span>}
                    </Link>
                  ))}
                </section>
              )}
    </AppShell>
  )
}
