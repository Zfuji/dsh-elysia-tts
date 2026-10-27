// 集成测试：用假 fetch + `process.execPath` 当播放器，覆盖
// 短回复整段 / 长回复流式 / 失败重试 / 同源鉴权 / 音量 / 新配置字段。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'elysia-it-'))
process.env.DSH_HOME = home
writeFileSync(join(home, 'elysia-tts.json'), JSON.stringify({ ffplay: process.execPath, auto: false, api: 'http://127.0.0.1:1' }), 'utf8')

const requests = []
let failNextTTS = false
let failStreaming = false
const wav = Buffer.alloc(4000, 1)
const pcm = Buffer.alloc(6400, 0)

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u.endsWith('/docs')) return { ok: true, status: 200, text: async () => '' }
  if (u.includes('/set_') || u.includes('/control')) return { ok: true, status: 200, text: async () => 'ok' }
  if (u.endsWith('/tts')) {
    const body = JSON.parse(init.body)
    requests.push(body)
    if (failNextTTS) {
      failNextTTS = false
      throw new Error('simulated network error')
    }
    if (body.streaming_mode && failStreaming) {
      return { ok: false, status: 500, text: async () => 'simulated streaming failure' }
    }
    // 文本里带「慢」的请求延迟 400ms，用来制造「队列积压」
    if (body.text.includes('慢')) await new Promise((r) => setTimeout(r, 400))
    if (body.streaming_mode) {
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(pcm))
            controller.enqueue(new Uint8Array(pcm))
            controller.close()
          }
        }),
        text: async () => ''
      }
    }
    return { ok: true, status: 200, arrayBuffer: async () => wav, text: async () => '' }
  }
  return { ok: true, status: 200, text: async () => '' }
}

const { apply } = await import('../lib/index.js')
const routes = new Map()
apply({
  effect: (fn) => fn(),
  interval: () => () => {},
  webServer: { register: (def) => (routes.set(def.path, def.handler), () => {}) },
  sessions: { list: () => [] }
})

const call = (path, { method = 'GET', body = null, headers = {} } = {}) =>
  new Promise((resolve, reject) => {
    const res = {
      code: 200,
      writeHead(code) {
        this.code = code
      },
      end(chunk) {
        resolve({ code: this.code, json: JSON.parse(chunk) })
      },
      on() {}
    }
    const req = {
      method,
      url: path,
      headers,
      on(event, cb) {
        if (event === 'data' && body) cb(Buffer.from(JSON.stringify(body)))
        if (event === 'end') cb()
        return this
      },
      destroy() {}
    }
    Promise.resolve(routes.get(path)(req, res)).catch(reject)
  })
const status = () => call('/elysia-tts/status').then((r) => r.json)

async function waitSpoken(before, timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const s = await status()
    if (s.spoken > before) return s
    await new Promise((r) => setTimeout(r, 80))
  }
  throw new Error('等不到 spoken 增长')
}

test('短回复走整段合成（cut5 + 非流式 + fragment_interval）', async () => {
  const s0 = await status()
  await call('/elysia-tts/say', { method: 'POST', body: { text: '短句测试。' } })
  await waitSpoken(s0.spoken)
  const last = requests[requests.length - 1]
  assert.equal(last.streaming_mode, false)
  assert.equal(last.text_split_method, 'cut5')
  assert.equal(last.fragment_interval, 0.05)
})

test('长回复走流式（cut5 + raw）', async () => {
  const s0 = await status()
  const text = '这是一段比较长的回复，用来确认它会走流式而不是整段合成。'.repeat(3)
  assert.ok(text.length > 60)
  await call('/elysia-tts/say', { method: 'POST', body: { text } })
  await waitSpoken(s0.spoken)
  const last = requests[requests.length - 1]
  assert.equal(last.streaming_mode, true)
  assert.equal(last.media_type, 'raw')
  assert.equal(last.text_split_method, 'cut5')
})

test('单次失败会自动重试并最终播出', async () => {
  const s0 = await status()
  failNextTTS = true
  const before = requests.length
  await call('/elysia-tts/say', { method: 'POST', body: { text: '重试测试。' } })
  const s1 = await waitSpoken(s0.spoken)
  assert.equal(s1.lastError, null)
  assert.equal(requests.length - before, 2, '应该恰好重试一次')
})

test('跨站请求被拦，同源放行', async () => {
  const cross = await call('/elysia-tts/say', {
    method: 'POST',
    body: { text: 'x' },
    headers: { 'sec-fetch-site': 'cross-site' }
  })
  assert.equal(cross.code, 403)
  const same = await call('/elysia-tts/status', { headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(same.code, 200)
})

test('音量可调并写入配置', async () => {
  const r = await call('/elysia-tts/preset', { method: 'POST', body: { volume: 60 } })
  assert.equal(r.json.volume, 60)
  assert.equal((await status()).volume, 60)
})

test('status 暴露新配置字段', async () => {
  const s = await status()
  assert.equal(s.fragmentInterval, 0.05)
  assert.equal(s.shortReplyChars, 60)
  assert.equal(s.sameSiteOnly, true)
})

test('缓存：同一句第二次命中，只发一次 /tts', async () => {
  const 句子 = '缓存命中测试。'
  const before = await status()
  const sent = () => requests.filter((r) => r.text === 句子).length
  assert.equal(sent(), 0, '这句还没发过')
  await call('/elysia-tts/say', { method: 'POST', body: { text: 句子 } })
  await waitSpoken(before.spoken)
  const mid = await status()
  await call('/elysia-tts/say', { method: 'POST', body: { text: 句子 } })
  await waitSpoken(mid.spoken)
  const after = await status()
  assert.equal(sent(), 1, '第二次应该命中缓存，不再请求引擎')
  assert.ok(after.cacheHits > before.cacheHits, 'cacheHits 应该增长')
})

test('流式失败会退回逐句（cut0）', async () => {
  const 内容 = '这是一段够长的文字用来触发流式路径。'.repeat(4)
  const before = await status()
  const start = requests.length
  failStreaming = true
  try {
    await call('/elysia-tts/say', { method: 'POST', body: { text: 内容 } })
    const after = await waitSpoken(before.spoken, 12000)
    assert.equal(after.lastError, null)
  } finally {
    failStreaming = false
  }
  const during = requests.slice(start)
  assert.ok(
    during.some((r) => r.streaming_mode === true),
    '应该先试过流式'
  )
  assert.ok(
    during.some((r) => r.streaming_mode === false && r.text_split_method === 'cut0'),
    '应该退回逐句 cut0'
  )
})

test('/stop 清空队列并中断当前朗读', async () => {
  const before = await status()
  await call('/elysia-tts/say', { method: 'POST', body: { text: '慢的请求，用来验证停止。' } })
  const stop = await call('/elysia-tts/stop', { method: 'POST' })
  assert.equal(stop.json.ok, true)
  assert.equal(typeof stop.json.cleared, 'number')
  const s = await status()
  assert.equal(s.queue, 0)
  await new Promise((r) => setTimeout(r, 700))
  const end = await status()
  assert.equal(end.spoken, before.spoken, '被停止的那段不应该算进 spoken')
})

test('队列满时丢掉最早的一段并累计 dropped', async () => {
  await call('/elysia-tts/config', { method: 'POST', body: { maxQueue: 1 } })
  const before = await status()
  // 第一条走「慢」分支，占住 worker；后两条只能排队，第二条会被挤掉
  await call('/elysia-tts/say', { method: 'POST', body: { text: '慢的第一条。' } })
  await new Promise((r) => setTimeout(r, 50))
  await call('/elysia-tts/say', { method: 'POST', body: { text: '排队第二条。' } })
  await call('/elysia-tts/say', { method: 'POST', body: { text: '排队第三条。' } })
  const s = await status()
  assert.ok(s.dropped > before.dropped, `dropped 应该增长：${before.dropped} -> ${s.dropped}`)
  assert.ok(s.queue <= 1)
  await call('/elysia-tts/config', { method: 'POST', body: { maxQueue: 3 } })
  await waitSpoken(before.spoken, 12000)
})

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
})
