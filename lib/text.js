/**
 * 纯文本处理：清理、切句、预算裁剪、静音裁剪。
 *
 * 这里刻意不碰任何状态，方便单测（`test/helpers.test.mjs` 直接测这些）。
 * @module dsh-elysia-tts/lib/text
 */

/** 单句硬上限：90 字要合成 40 秒以上，句间空档就藏不住了。 */
export const 单句上限 = 45

/**
 * 把模型输出清理成「能念」的句子：去掉代码块、链接、URL、HTML、markdown 标记和 emoji。
 * @param {unknown} s 原始文本
 * @returns {string}
 */
export function 去不能念的(s) {
  let t = String(s == null ? '' : s)
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/`[^`]*`/g, ' ')
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  t = t.replace(/https?:\/\/\S+/g, ' ')
  t = t.replace(/<[^>\n]{1,80}>/g, ' ')
  t = t.replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ') // markdown 表格行
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  t = t.replace(/[*_~]{1,3}/g, '')
  // oxlint-disable-next-line no-misleading-character-class -- 变体选择符 FE0F 就是要跟着 emoji 一起删
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
  t = t.replace(/[（(][^）)]*[）)]/g, (m) => (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(m) ? m : ' '))
  t = t.replace(/[ \t\u3000]+/g, ' ')
  t = t.replace(/\n{2,}/g, '\n')
  return t.trim()
}

/**
 * 切句：按中英文标点切；太短的（<8 字）并到前一句，太长的在逗号处或 45 字硬切。
 * @param {unknown} text
 * @returns {string[]}
 */
export function 切句(text) {
  const raw = String(text)
    .split(/(?<=[。！？!?；;…\n])/u)
    .map((x) => x.trim())
    .filter(Boolean)
  const merged = []
  for (const piece of raw) {
    if (merged.length && piece.length < 8) merged[merged.length - 1] += piece
    else merged.push(piece)
  }
  const fin = []
  for (const s of merged) {
    let rest = s
    while (rest.length > 单句上限) {
      const window = rest.slice(0, 单句上限)
      const cut = Math.max(
        window.lastIndexOf('，'),
        window.lastIndexOf(','),
        window.lastIndexOf('、'),
        window.lastIndexOf('：'),
        window.lastIndexOf(':')
      )
      const at = cut > 12 ? cut + 1 : 单句上限
      fin.push(rest.slice(0, at))
      rest = rest.slice(at)
    }
    if (rest) fin.push(rest)
  }
  return fin
}

/**
 * 按字数预算挑要念的内容。
 * 默认取尾部（长回答的开场白通常是「我先看看…」，结论在最后）；
 * `mode: 'head'` 则取头部。
 * @param {unknown} text
 * @param {unknown} budget 字数上限
 * @param {'tail'|'head'} [mode]
 * @returns {string}
 */
export function 取预算(text, budget, mode = 'tail') {
  const s = String(text == null ? '' : text).trim()
  const limit = Math.max(20, Number(budget) || 150)
  if (s.length <= limit) return s
  const parts = 切句(s)
  const picked = []
  let n = 0
  if (mode === 'head') {
    for (const piece of parts) {
      if (picked.length && n + piece.length > limit) break
      picked.push(piece)
      n += piece.length
    }
  } else {
    for (let i = parts.length - 1; i >= 0; i--) {
      const piece = parts[i]
      if (picked.length && n + piece.length > limit) break
      picked.unshift(piece)
      n += piece.length
    }
  }
  if (!picked.length) return mode === 'head' ? s.slice(0, limit) : s.slice(-limit)
  return picked.join('')
}

/**
 * 把 wav 末尾的静音剪掉（GPT-SoVITS 每段自带 ~0.45s 尾巴，句句都留着就是死气）。
 * 只动 data 块长度，不重新编码。
 * @param {Buffer} buf
 * @param {number} sr 采样率
 * @param {number} [threshold] 静音阈值（int16 幅度）
 * @param {number} [keepMs] 保留的毫秒数
 * @returns {Buffer}
 */
export function 裁尾静音(buf, sr, threshold = 200, keepMs = 120) {
  try {
    if (buf.length < 64 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf
    let off = 12
    let dataOff = -1
    let dataLen = 0
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') {
        dataOff = off + 8
        dataLen = Math.min(size, buf.length - dataOff)
        break
      }
      off += 8 + size + (size % 2)
    }
    if (dataOff < 0 || dataLen < 4) return buf
    const n = Math.floor(dataLen / 2)
    let last = n - 1
    while (last >= 0 && Math.abs(buf.readInt16LE(dataOff + last * 2)) <= threshold) last--
    if (last < 0) return buf
    const keepSamples = Math.min(n, last + 1 + Math.round(((Number(sr) || 32000) * keepMs) / 1000))
    if (keepSamples >= n - 1) return buf
    const out = Buffer.from(buf.subarray(0, dataOff + keepSamples * 2))
    out.writeUInt32LE(keepSamples * 2, dataOff - 4)
    out.writeUInt32LE(out.length - 8, 4)
    return out
  } catch {
    return buf
  }
}

/**
 * 流式 PCM 的静音压缩器：把超过 maxSilenceMs 的连续静音截短，
 * 跨 chunk 的静音也能接上算（状态留在闭包里）。
 * @param {number} sr 采样率
 * @param {number} maxSilenceMs 最长保留的静音
 * @returns {(chunk: Buffer) => Buffer}
 */
export function 静音压缩(sr, maxSilenceMs) {
  const limit = Math.round(((Number(sr) || 32000) * Math.max(60, Number(maxSilenceMs) || 200)) / 1000)
  let quiet = 0
  let carry = Buffer.alloc(0)
  return (chunk) => {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const n = Math.floor(buf.length / 2)
    carry = n * 2 < buf.length ? Buffer.from(buf.subarray(n * 2)) : Buffer.alloc(0)
    const out = Buffer.allocUnsafe(n * 2)
    let w = 0
    for (let i = 0; i < n; i++) {
      const s = buf.readInt16LE(i * 2)
      if (Math.abs(s) <= 200) {
        quiet++
        if (quiet > limit) continue
      } else quiet = 0
      out.writeInt16LE(s, w)
      w += 2
    }
    return out.subarray(0, w)
  }
}
