// 只测纯函数和扫描器：这两块是「会不会念错」的核心，且不需要 DSH 运行时。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { 切句, 取预算, 去不能念的, 切块, createScanner, 裁尾静音, 静音压缩 } from '../lib/index.js'

/** 造一段 32kHz/mono/s16 的 wav：samples 是振幅序列。 */
function wav(samples, sr = 32000) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sr, 24)
  h.writeUInt32LE(sr * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
const tone = (sec, amp = 2000, sr = 32000) => Array(Math.round(sec * sr)).fill(amp)
const silence = (sec, sr = 32000) => Array(Math.round(sec * sr)).fill(0)

test('裁尾静音：剪掉尾巴但保留 120ms 余量，头部结构不变', () => {
  const buf = wav([...tone(0.5), ...silence(1.0)])
  const out = 裁尾静音(buf, 32000)
  const dataLen = out.readUInt32LE(40)
  const dur = dataLen / 2 / 32000
  assert.ok(dur > 0.55 && dur < 0.7, `裁后时长异常：${dur}`)
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF 长度要同步')
  assert.equal(out.toString('ascii', 0, 4), 'RIFF')
})

test('裁尾静音：本来就短或全静音时原样返回', () => {
  const quiet = wav(silence(1.0))
  assert.equal(裁尾静音(quiet, 32000), quiet)
  const short = wav([1000, 2000, 3000])
  assert.equal(裁尾静音(short, 32000), short)
})

test('静音压缩：2 秒停顿压到 200ms，跨 chunk 也接得上', () => {
  const samples = [...tone(0.4), ...silence(2.0), ...tone(0.4)]
  const squeeze = 静音压缩(32000, 200)
  const parts = []
  for (let i = 0; i < samples.length; i += 1000) {
    const chunk = Buffer.alloc(Math.min(1000, samples.length - i) * 2)
    for (let k = 0; k < chunk.length / 2; k++) chunk.writeInt16LE(samples[i + k], k * 2)
    parts.push(squeeze(chunk))
  }
  const total = parts.reduce((a, b) => a + b.length, 0)
  const dur = total / 2 / 32000
  assert.ok(dur >= 0.98 && dur < 1.3, `压缩后时长异常：${dur}`)
})

test('预设库：id 唯一、文字/文件非空、时长 3–7s、文件都在（没有真实清单时跳过）', () => {
  const real = new URL('../lib/presets.json', import.meta.url)
  const example = new URL('../lib/presets.example.json', import.meta.url)
  const own = existsSync(real)
  const db = JSON.parse(readFileSync(own ? real : example, 'utf8'))
  const list = db.presets
  assert.ok(list.length >= 1, '预设为空')
  assert.equal(new Set(list.map((p) => p.id)).size, list.length, 'id 有重复')
  for (const p of list) {
    assert.ok(p.id && p.file && p.text && p.emotion, '缺字段：' + JSON.stringify(p))
    assert.ok(p.dur >= 3 && p.dur <= 7, `${p.id} 时长越界：${p.dur}`)
    assert.ok(!p.text.startsWith('【'), `${p.id} 的 text 还带着情绪标签`)
    // 只有本机真实清单才检查音频是否存在；公开仓库里只带示例
    if (own && existsSync(db.dir)) {
      assert.ok(existsSync(join(db.dir, p.file)), `${p.id} 找不到参考音：${p.file}`)
    }
  }
})

/** 够用的 Session 替身：seq 是日志长度，snapshotEvents(from) 取后缀。 */
function fakeSession(id, events, header = {}) {
  return {
    id,
    header,
    get seq() {
      return events.length
    },
    snapshotEvents: (from) => events.slice(from)
  }
}

test('去不能念的：代码块、链接、emoji 不念', () => {
  const raw = [
    '先说结论：**可以**。',
    '```js',
    'const a = 1',
    '```',
    '见 https://example.com/x 和 `inline`。',
    '![图](a.png)',
    '🐳 出发吧'
  ].join('\n')
  const out = 去不能念的(raw)
  assert.equal(out.includes('https'), false)
  assert.equal(out.includes('const a'), false)
  assert.equal(out.includes('inline'), false)
  assert.equal(out.includes('🐳'), false)
  assert.ok(out.includes('先说结论'))
  assert.ok(out.includes('出发吧'))
})

test('切句：短句并前、长句按逗号或 45 字切开', () => {
  const sentences = 切句('好的。嗯。今天天气不错，要不要一起出去走走？我觉得路边的花都开了，而且风也刚刚好，适合散步。')
  assert.ok(sentences.length >= 2)
  for (const s of sentences) assert.ok(s.length <= 45, `超长句：${s.length}`)
  assert.ok(sentences[0].includes('好的。嗯。'), '过短的句子应并入前一句')

  const long = '这'.repeat(120)
  const hard = 切句(long)
  assert.ok(hard.every((s) => s.length <= 45))
  assert.equal(hard.join(''), long, '硬切不能丢字')
})

test('取预算：默认取尾部结论，head 模式取开头', () => {
  const text = '第一句话说完了。第二句话也说完了。第三句话还说完了。第四句话快说完了。第五句话真的说完了。'
  const tail = 取预算(text, 40)
  assert.ok(tail.length <= 40, `尾部预算超了：${tail.length}`)
  assert.ok(tail.includes('第五句'), `尾部预算应包含结论：${tail}`)
  assert.equal(tail.includes('第一句'), false)

  const head = 取预算(text, 40, 'head')
  assert.ok(head.length <= 40)
  assert.ok(head.includes('第一句'))
  assert.equal(head.includes('第五句'), false)
})

test('取预算：没有标点的超长输入也不越界', () => {
  const text = '啊'.repeat(500)
  const out = 取预算(text, 80)
  assert.ok(out.length <= 80, `超出预算：${out.length}`)
  assert.ok(out.length > 0)
})

test('扫描器：一轮结束后只念最后一条有文字的助手消息', () => {
  const events = []
  const seen = []
  const scan = createScanner(
    (text, id, turn) => seen.push({ text, id, turn }),
    (e) => {
      throw e
    }
  )
  const session = fakeSession('s1', events)

  events.push({ type: 'turn/start', seq: 0, data: { turn: 1 } })
  scan([session]) // 首轮只记水位，不念历史
  assert.deepEqual(seen, [])

  const push = (type, data) => events.push({ type, seq: events.length, time: 0, data })
  push('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先看看文件。' }] } })
  push('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'tool-call', name: 'read' }] } })
  push('assistant/message', { turn: 1, step: 3, message: { content: [{ type: 'text', text: '结论：这里没问题。' }] } })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  scan([session])

  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, '结论：这里没问题。')
  assert.equal(seen[0].turn, 1)

  scan([session])
  assert.equal(seen.length, 1, '同一批事件不能重复念')

  push('turn/start', { turn: 2 })
  push('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '这句不该念。' }] } })
  push('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  scan([session])
  assert.equal(seen.length, 1, '被打断的轮次不念')
})

test('扫描器：会话重启（seq 回退）后重新记水位，不念旧账', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '旧内容' }] } } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } }
  ]
  const seen = []
  const scan = createScanner(
    (text) => seen.push(text),
    (e) => {
      throw e
    }
  )
  const session = fakeSession('s1', events)
  scan([session])
  assert.deepEqual(seen, [], '首次扫到已有历史不念')

  events.length = 0 // 会话被重建
  scan([session])
  assert.deepEqual(seen, [])
})

test('切块：长文按句子分组，不切在句子中间', () => {
  const sentence = '这是一句用来测试分块的中文句子，长度大约二十个字左右。'
  const text = sentence.repeat(40)
  const chunks = 切块(text, 300)
  assert.ok(chunks.length > 1, '应该被切成多块')
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 300 + sentence.length, `块过长：${chunk.length}`)
    assert.ok(chunk.endsWith('。'), `块应该停在句末：${chunk.slice(-6)}`)
  }
  assert.equal(chunks.join(''), text, '拼起来应该和原文一致')
})

test('切块：短文本只出一块', () => {
  const chunks = 切块('你好呀。今天也要开心。', 600)
  assert.equal(chunks.length, 1)
})
