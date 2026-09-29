/**
 * 角色页（外观移植自 Rpgforge 的 PARTY）：只列在正文里出场过的人物（防剧透），点开看档案。
 * Rpgforge 这一页是编辑器（改字段、传立绘）；TaleForge 改剧本走唤起 GM，立绘先不做，所以这里只读。
 */
import { useState } from 'react'
import type { CastMember } from '../cast.ts'
import { AppShell, Loading } from '../components/AppShell.tsx'
import { CharacterModal, CharacterPortrait } from '../components/CharacterModal.tsx'
import { GameSubpageShell } from '../components/GameMenu.tsx'
import { Link } from '../router.tsx'
import { EmptyText, ErrorCard, useLoad } from './common.tsx'
import { loadGame } from './gameData.ts'

export function CharactersPage({ gameId }: { gameId: string }) {
  const [state] = useLoad(() => loadGame(gameId), [gameId])
  const [selected, setSelected] = useState<CastMember>()
  if (state.status !== 'ready') {
    return <AppShell variant="focus">{state.status === 'loading' ? <Loading text="正在读取角色…" /> : <ErrorCard message={state.message} />}</AppShell>
  }
  const { story, knownCast } = state.data
  const known = story.cast.filter(c => knownCast.has(c.id))
  const hidden = story.cast.length - known.length
  const protagonist: CastMember = { id: '__protagonist', name: story.protagonist.name, identity: story.protagonist.identity }

  return (
    <AppShell variant="focus">
      <GameSubpageShell
        active="characters"
        eyebrow="PARTY · 角色"
        gameId={gameId}
        primaryAction={<Link className="px-btn px-btn-primary w-full sm:w-fit" href={`/games/${gameId}/play`}>▸ 继续冒险</Link>}
        subtitle={`已结识 ${known.length} 人${hidden > 0 ? ` · 还有 ${hidden} 人尚未登场` : ''}`}
        title={story.title}
      >
        <section className="px-panel px-panel-pad">
          <h2 className="px-heading text-lg">主角</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <CharacterCard character={protagonist} role="主角" onOpen={setSelected} />
          </div>
        </section>
        <section className="px-panel px-panel-pad">
          <h2 className="px-heading text-lg">出场人物</h2>
          {known.length === 0
            ? <div className="mt-4"><EmptyText>还没有遇到别的人。</EmptyText></div>
            : (
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {known.map(c => <CharacterCard key={c.id} character={c} role="出场人物" onOpen={setSelected} />)}
                </div>
              )}
          {hidden > 0 && <p className="mt-4 text-sm text-[color:var(--faint)]">…还有尚未遇到的人。</p>}
        </section>
      </GameSubpageShell>
      <CharacterModal character={selected} role={selected?.id === '__protagonist' ? '主角' : '出场人物'} onClose={() => setSelected(undefined)} />
    </AppShell>
  )
}

function CharacterCard({ character, role, onOpen }: { character: CastMember; role: string; onOpen: (c: CastMember) => void }) {
  return (
    <button className="px-card grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-3 text-left hover:border-[color:var(--phosphor-dim)]" onClick={() => onOpen(character)} type="button">
      <CharacterPortrait name={character.name} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="break-words">{character.name}</strong>
          <span className="px-badge">{role}</span>
        </div>
        <p className="px-wrap mt-2 line-clamp-4 text-sm leading-6 text-[color:var(--muted)]">{character.identity}</p>
      </div>
    </button>
  )
}
