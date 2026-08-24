/**
 * 文风漂移的事实回灌（治"衰减型"问题）。
 *
 * 平台原有的七种质量手段全是同一种：把同一段声明挪到离生成点更近的地方。它对
 * **判断型**问题有效——回合头注入把"整回合漏调 report_progress"从 55% 打到 6%；
 * 但对**衰减型**问题无能为力，因为它每回合说的话一模一样，而问题在累积。
 *
 * 252 回合观测的实证（apps/bff observer.jsonl）：强调标记随局长单调衰减，
 * 1–3 回合均值 2.75、达标 61%，到 26 回合以后只剩均值 0.41、达标 9%，
 * 七成回合一处不用。原因是正文自己的先例比 persona 里任何声明都更贴近生成点——
 * 前几回合少了，后面跟着少，自我强化。
 *
 * 解药不是再喊一遍"每回合 2–4 处"（那是声明，会被先例压过），而是把**事实**贴回去：
 * "上两回合 0 处、1 处"。声明可以被无视，事实不好反驳。
 *
 * 三条纪律，别改坏：
 * - **连续不达标才提**：单回合 0 处是正常波动（有些回合确实没有新专有名词），
 *   对波动过度反应会逼出反弹（历史数据里有 12 处、10 处的极端值）。
 * - **达标即撤**：这是闭环不是第八条常驻提醒；平时不注入，注入块反而更短。
 * - **只报事实与类型，不训诫**：给数字、给类型，别让 GM 去判断"够不够格"——
 *   凡是留给它判断的规则，它一律选择不做。
 */

/** 一个已完成回合的可观测事实（正文只在内存里流转，不落盘）。 */
export interface TurnFact {
  kind: 'play' | 'offstage' | 'aborted'
  /** 正文里 **加粗** 的处数 */
  markers: number
  /** 玩家可见正文 */
  text: string
}

/** 强调标记的下限；上限只写进提醒文案，不参与判定（超了不算问题）。 */
const MARKER_FLOOR = 2
/** 连续多少个正戏回合不达标才提醒 */
const MARKER_STREAK = 2
/** 强度词表连续多少个正戏回合零命中才提醒 */
const INTENSITY_STREAK = 3

/** 词表在一段正文里的命中次数（词表由剧本声明，平台只数数、不判断内容）。 */
export function intensityHits(text: string, words: readonly string[]): number {
  let hits = 0
  for (const w of words) {
    if (!w) continue
    let from = 0
    for (;;) {
      const at = text.indexOf(w, from)
      if (at < 0) break
      hits++
      from = at + w.length
    }
  }
  return hits
}

/**
 * 按最近若干回合的事实生成注入行；一切达标就返回空数组（不注入）。
 * @param recent - 最近的回合事实，**新的在前**（recent[0] 是刚结束的那回合）。
 * @param words - 剧本声明的强度词表；没声明就不查这一项。
 */
export function driftNotes(recent: readonly TurnFact[], words: readonly string[] = []): string[] {
  const plays = recent.filter(t => t.kind === 'play')
  const notes: string[] = []

  const markerRun = plays.slice(0, MARKER_STREAK)
  if (markerRun.length === MARKER_STREAK && markerRun.every(t => t.markers < MARKER_FLOOR)) {
    // 倒着念，读起来是时间顺序："上两回合 1 处、0 处"
    const counts = markerRun.map(t => t.markers).reverse().join(' 处、')
    notes.push(
      `【笔触】上${MARKER_STREAK === 2 ? '两' : MARKER_STREAK}回合强调标记只有 ${counts} 处。`
      + '每回合 2–4 处，标的是本回合新出现的专有名词、关键物品、异常现象，'
      + '以及动作或局势的转折点——不是按"够不够重要"挑，是按内容属于哪一类挑。',
    )
  }

  if (words.length) {
    const intensityRun = plays.slice(0, INTENSITY_STREAK)
    if (intensityRun.length === INTENSITY_STREAK
      && intensityRun.every(t => intensityHits(t.text, words) === 0)) {
      notes.push(
        `【强度】上${INTENSITY_STREAK} 个回合的正文，剧本声明的直白用词一次都没出现。`
        + 'rating 是本剧写多深的唯一契约，按它写；别跟着前文攒下的含蓄先例走。',
      )
    }
  }

  return notes
}
