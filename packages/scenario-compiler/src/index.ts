/**
 * 剧本编译器：剧本源（story.json）→ 校验后的剧本对象 + GM 的固定前缀文本。
 * v2 起不再生成 dsh preset 目录：引擎直接读剧本目录，每回合现取现行正式版。
 */
export { isStoryId, loadStory, scanCatalog, type CatalogEntry } from './catalog.ts'
export { applyRevisionsToStory, type MergeResult, type RevisionLike } from './merge.ts'
export { renderPersona, type PersonaAct, type PersonaState } from './persona.ts'
export { craftModuleNames, storySchema, type CraftModule, type LoreEntry, type Story } from './schema.ts'
export { WORKSHOP_PERSONA } from './workshop.ts'
