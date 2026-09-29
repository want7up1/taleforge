import assert from 'node:assert/strict'
import { test } from 'node:test'
import { knownCastIds, mentionedIn } from './cast.ts'
import { matchPath } from './paths.ts'

test('路径匹配：参数取出、段数不同或字面不同都不匹配、结尾斜杠容忍', () => {
  assert.deepEqual(matchPath('/games/:id/play', '/games/s-1/play'), { id: 's-1' })
  assert.deepEqual(matchPath('/games/:id/play', '/games/s-1/play/'), { id: 's-1' })
  assert.equal(matchPath('/games/:id/play', '/games/s-1/camp'), undefined)
  assert.equal(matchPath('/games/:id', '/games/s-1/play'), undefined)
  assert.deepEqual(matchPath('/library/:id/edit', '/library/story-a%20b/edit'), { id: 'story-a b' })
})

const cast = [
  { id: 'su', name: '苏晚晴', identity: '医生' },
  { id: 'lin', name: '林绾绾', identity: '偶像' },
  { id: 'zhao', name: '赵六', identity: '猎户' },
]

test('防剧透：全名或去姓的简称出现过才算已出场；两字名不做简称', () => {
  assert.deepEqual([...knownCastIds(cast, '晚晴递来纱布。')], ['su'])
  assert.deepEqual([...knownCastIds(cast, '六子没来。')], [])
})

test('在场角色按正文里先出场的排前面', () => {
  assert.deepEqual(mentionedIn(cast, '绾绾看着赵六，苏晚晴没说话。').map(c => c.id), ['lin', 'zhao', 'su'])
})
