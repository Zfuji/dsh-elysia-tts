/**
 * 会话扫描器：增量读 DSH 的 session 事件，只在「一整轮说完且成功」时回调。
 *
 * 只保留这一轮里最后一条有文字内容的 assistant 消息——中间那些「我先看一下」
 * 的过程独白不该被念；工具调用步骤本身没有 text 块，不会覆盖它。
 * @module dsh-elysia-tts/lib/scanner
 */

/**
 * @param {(text: string, sessionId: string, turn: number) => void} onCompleted
 * @param {(error: unknown, sessionId: string) => void} onError
 * @returns {(sessions: Array<{id: unknown, seq: unknown, snapshotEvents: (from: number) => Array<any>}>) => void}
 */
export function createScanner(onCompleted, onError) {
  const tracked = new Map()
  return (sessions) => {
    const alive = new Set()
    for (const session of sessions) {
      const id = String(session.id)
      const seq = Number(session.seq)
      alive.add(id)
      let st = tracked.get(id)
      if (!st || seq < st.seq) {
        // session.seq 是「下一条事件的序号」，等于日志长度；先记下它，历史不重念。
        tracked.set(id, { seq, turns: new Map() })
        continue
      }
      if (seq <= st.seq) continue
      let events
      try {
        events = session.snapshotEvents(st.seq)
      } catch (error) {
        onError(error, id)
        continue
      }
      st.seq = seq
      for (const event of events) {
        if (!event) continue
        const data = event.data || {}
        if (data.turn === undefined || data.turn === null) continue
        if (event.type === 'assistant/message') {
          const blocks = data.message && data.message.content
          const parts = []
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                parts.push(block.text.trim())
              }
            }
          }
          if (parts.length) st.turns.set(data.turn, parts.join('\n\n'))
        } else if (event.type === 'turn/end') {
          const text = st.turns.get(data.turn)
          st.turns.delete(data.turn)
          if (data.reason && data.reason.kind === 'completed' && text) {
            onCompleted(text, id, data.turn)
          }
        }
      }
    }
    for (const id of tracked.keys()) if (!alive.has(id)) tracked.delete(id)
  }
}
