// dsh-elysia-tts · 宿主半边
// 盯住 DSH 里活着的会话 → 每说完一整轮，就把文字送去本地 GPT-SoVITS
// （爱莉希雅 LoRA）合成，然后用 ffplay 在本机放出来。
//
// 设计取舍：不做网页半边。DSH 桌面端就跑在这台机器上，宿主放声 = 你听得到，
// 少一个客户端 bundle 就少一处能坏的地方。
//
// CPU 推理比播放慢（实测 RTF≈1.6），所以按句切、合成一句放一句，
// 并且播放第 N 句时第 N+1 句已经在合成（预取），把「每句一停」压成一次尾巴等待。

import { readFileSync, writeFileSync, mkdirSync, rmSync, openSync, readdirSync, statSync, renameSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export const name = 'elysia-tts'
export const inject = ['sessions', 'timer', 'webServer']

const P = '/elysia-tts'
const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_PATH = join(CFG_DIR, 'elysia-tts.json')

/** 单句硬上限：90 字要合成 40 秒以上，句间空档就藏不住了。 */
const 单句上限 = 45

const DEFAULTS = {
  auto: true,
  api: 'http://127.0.0.1:9880',
  /** 以下路径都是示例默认值，装好后请用控制台或 %DSH_HOME%\elysia-tts.json 改成你自己的。 */
  root: 'D:\\GPT-SoVITS\\GPT-SoVITS-v4-20250529',
  python: '',
  gptWeights: 'D:\\GPT-SoVITS\\weights\\Elysia-e15.ckpt',
  sovitsBase: '',
  sovitsWeights: 'D:\\GPT-SoVITS\\weights\\Elysia_e16_s8720.pth',
  refAudio: 'D:\\GPT-SoVITS\\refs\\ref.wav',
  promptText: '这行填参考音对应的台词，必须和音频逐字一致。',
  modelDir: 'D:\\GPT-SoVITS\\weights',
  promptLang: 'zh',
  textLang: 'zh',
  speed: 1.0,
  sampleSteps: 4,
  parallelInfer: false,
  /** 采样参数（语气档就是改这三个）。实测收紧后合成快 35~40%，输出时长也更稳。 */
  temperature: 0.8,
  topK: 15,
  topP: 0.85,
  /** >=0 时固定随机种子，同一句每次输出完全一致；-1 每次随机。 */
  seed: -1,
  /** 语气档：stable=稳定 / lively=生动 / custom=手动调过参数 */
  style: 'stable',
  /** 流式：一次请求内部按标点切段、边生成边播；关掉则退回「逐句请求 + 预取」。 */
  streaming: true,
  /** 合成采样率（v2 模型固定 32000）。流式 PCM 没有文件头，必须知道它。 */
  sampleRate: 32000,
  /** 静音裁剪：把超过 maxSilenceMs 的停顿压到这么短，避免模型每段自带的 0.45s 尾巴。 */
  trimSilence: true,
  maxSilenceMs: 200,
  /** 服务端在 cut5 每段之间插入的静音长度（秒）。默认 0.3 太长，段段累加就是死气。 */
  fragmentInterval: 0.05,
  /** 播放音量 0–100（ffplay -volume）。 */
  volume: 100,
  /** 这么短的回复直接整段合成再播，省掉段间空隙；0 = 关闭该策略。 */
  shortReplyChars: 60,
  /** 只接受同源请求（拦掉别的小网页用 <img> 触发 /say）。 */
  sameSiteOnly: true,
  autoStart: true,
  ffplay: 'ffplay',
  maxQueue: 3,
  maxChars: 150,
  /** 超长回复取哪一头念：tail=只念结论，head=只念开场。 */
  trim: 'tail',
  mplConfigDir: 'D:\\GPT-SoVITS\\.mplconfig',
  logDir: 'D:\\GPT-SoVITS\\logs',
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/**
 * 参考音预设库：`lib/presets.json`（不进仓库，放你自己的参考音清单）。
 * 没有这个文件时读 `presets.example.json` 当占位，并提示你复制一份。
 * 运行时只读这一个 JSON，不扫目录、不调 ffprobe。
 */
const PRESET_DB = (() => {
  try {
    return { ...JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8')), missing: false }
  } catch {
    try {
      const example = JSON.parse(readFileSync(new URL('./presets.example.json', import.meta.url), 'utf8'))
      return { ...example, missing: true }
    } catch {
      return { dir: '', presets: [], missing: true }
    }
  }
})()
const PRESETS = Array.isArray(PRESET_DB.presets) ? PRESET_DB.presets.filter((p) => p && p.file && p.text) : []
if (PRESET_DB.missing) {
  console.warn('[爱莉希雅朗读] 没找到 lib/presets.json，先按 presets.example.json 占位；复制一份并填好参考音路径/台词。')
}

// 预设库读不出来时的最后兜底：三条只动参数的占位（文件要自己放）。
const FALLBACK_PRESETS = [
  { id: 'r1', emotion: '普通', label: '普通 · 示例 1', file: 'ref-normal.wav', text: '这行填参考音对应的台词，必须和音频逐字一致。' },
  { id: 'r2', emotion: '开心', label: '开心 · 示例 2', file: 'ref-happy.wav', text: '开心的参考音台词。' },
  { id: 'r3', emotion: '撒娇', label: '撒娇 · 示例 3', file: 'ref-sweet.wav', text: '撒娇的参考音台词。' },
]
const ACTIVE_PRESETS = PRESETS.length ? PRESETS : FALLBACK_PRESETS
const PRESET_DIR = PRESET_DB.dir || (PRESETS.length ? '' : 'D:\\GPT-SoVITS\\refs')

DEFAULTS.presetDir = PRESET_DIR
if (ACTIVE_PRESETS.length) {
  // 默认参考音取库里第一条（零内部停顿那条），比原来的 r2 稳。
  DEFAULTS.refAudio = join(PRESET_DIR, ACTIVE_PRESETS[0].file)
  DEFAULTS.promptText = ACTIVE_PRESETS[0].text
}

/**
 * 语气档：采样参数是「节奏/起伏」，真正决定情绪的是参考音。
 * 所以带 `refEmotion` 的档会顺手把参考音切到那一组的第一条（撒娇/撩拨/调皮/温柔），
 * 不带的那几档只动参数，保留你手选的参考音。
 */
const STYLES = [
  { id: 'stable', label: '稳定', params: { temperature: 0.8, topK: 15, topP: 0.85 } },
  { id: 'natural', label: '自然', params: { temperature: 0.9, topK: 20, topP: 0.9 } },
  { id: 'lively', label: '生动', params: { temperature: 0.95, topK: 10, topP: 0.9 } },
  { id: 'sweet', label: '撒娇', params: { temperature: 0.95, topK: 15, topP: 0.9 }, refEmotion: '撒娇' },
  { id: 'tease', label: '撩拨', params: { temperature: 0.9, topK: 15, topP: 0.9 }, refEmotion: '撩拨' },
  { id: 'playful', label: '调皮', params: { temperature: 1.0, topK: 20, topP: 0.9 }, refEmotion: '调皮' },
  { id: 'tender', label: '温柔', params: { temperature: 0.75, topK: 15, topP: 0.85 }, refEmotion: '感动' },
  { id: 'calm', label: '平静', params: { temperature: 0.7, topK: 10, topP: 0.8 } },
]
const STYLE_MAP = new Map(STYLES.map((s) => [s.id, s]))
const 代表参考音 = (emotion) => ACTIVE_PRESETS.find((p) => p.emotion === emotion)

/** SoVITS 版本预设：同一批数据训出来的两个存档点。 */
const MODEL_PRESETS = [
  { id: 'e16', label: 'e16 · 稳一些', file: 'Elysia_v2_e16_s8720.pth' },
  { id: 'e24', label: 'e24 · 学得更久', file: 'Elysia_v2_e24_s13080.pth' },
]

function loadCfg() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CFG_PATH, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveCfg(cfg) {
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (error) {
    console.error('[爱莉希雅朗读] 存配置失败：' + (error && error.message))
  }
}

/** 把模型输出清理成「能念」的句子。 */
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
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
  t = t.replace(/[（(][^）)]*[）)]/g, (m) => (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(m) ? m : ' '))
  t = t.replace(/[ \t\u3000]+/g, ' ')
  t = t.replace(/\n{2,}/g, '\n')
  return t.trim()
}

/** 切句：按中文/英文标点切；太短的（<8 字）并到前一句，太长的在逗号处或 45 字硬切。 */
export function 切句(text) {
  const raw = String(text).split(/(?<=[。！？!?；;…\n])/u).map((x) => x.trim()).filter(Boolean)
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
        window.lastIndexOf(':'),
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
 * `mode: 'head'` 则保留原来的取头部行为。
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
 * 增量扫描会话事件，只在「一整轮说完且成功」时回调。
 * 只保留这一轮里最后一条有文字内容的 assistant 消息——中间那些「我先看一下」
 * 的过程独白不该被念；工具调用步骤本身没有 text 块，不会覆盖它。
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

/**
 * 把 wav 末尾的静音剪掉（GPT-SoVITS 每段自带 ~0.45s 尾巴，句句都留着就是死气）。
 * 只动 data 块长度，不重新编码。
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

export function apply(ctx) {
  const cfg = loadCfg()
  const say = (m) => console.log('[爱莉希雅朗读] ' + m)
  const state = {
    queue: [],
    playing: null,
    apiReady: false,
    lastError: null,
    spoken: 0,
    dropped: 0,
    cacheHits: 0,
    weightsOk: false,
    /** 每次 /stop 自增：老的合成/播放循环看到代号变了就收手。 */
    epoch: 0,
    controller: new AbortController(),
  }

  const reply = (res, code, obj) => {
    res.writeHead(code, HEADERS)
    res.end(JSON.stringify(obj))
  }
  const readJson = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 200000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const abs = (p) => (isAbsolute(p) ? p : join(cfg.root, p))

  /** 清掉上次异常退出留下的临时 wav（只碰自己的前缀）。 */
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!/^elysia-.*\.wav$/.test(name)) continue
      const file = join(tmpdir(), name)
      try {
        if (Date.now() - statSync(file).mtimeMs > 6 * 3600 * 1000) rmSync(file, { force: true })
      } catch {}
    }
  } catch {}

  // ---- GPT-SoVITS 服务 ----
  let apiChild = null
  async function apiAlive() {
    try {
      const r = await fetch(cfg.api + '/docs', { signal: AbortSignal.timeout(2500) })
      if (r.status === 200) return true
      if (r.status !== 404) return false
      // /docs 被关掉时，用「/tts 只接受 POST」这个签名确认对面是 GPT-SoVITS，
      // 而不是 9880 上碰巧占着端口的别的服务。
      const probe = await fetch(cfg.api + '/tts', { signal: AbortSignal.timeout(2500) })
      return probe.status === 405 || probe.status === 422
    } catch {
      return false
    }
  }

  /**
   * 探活要容忍「引擎正在忙」：合成期间 FastAPI 的事件循环被同步推理占住，
   * /docs 会超时。误判成「没起来」就会重复拉一个进程、还会把权重再装一遍。
   * 所以先重试几次，仍然不通才认为真的挂了。
   */
  async function apiLookAlive() {
    for (let i = 0; i < 3; i++) {
      if (await apiAlive()) return true
      if (i < 2) await new Promise((r) => setTimeout(r, 800))
    }
    return false
  }

  /** 日志超过 5MB 就轮转一次，避免 tqdm 进度条把日志撑爆。 */
  const 轮转日志 = (file, maxBytes = 5 * 1024 * 1024) => {
    try {
      if (statSync(file).size <= maxBytes) return
      rmSync(file + '.1', { force: true })
      renameSync(file, file + '.1')
    } catch {}
  }

  async function ensureApi() {
    if (await apiLookAlive()) {
      state.apiReady = true
      return true
    }
    state.weightsOk = false
    if (!cfg.autoStart) return false
    if (apiChild === null) {
      const python = cfg.python || join(cfg.root, 'runtime', 'python.exe')
      const script = join(cfg.root, 'api_v2.py')
      say('启动 GPT-SoVITS：' + python)
      try {
        mkdirSync(cfg.mplConfigDir, { recursive: true })
        mkdirSync(cfg.logDir, { recursive: true })
        const logFile = join(cfg.logDir, 'tts-api.log')
        const errFile = join(cfg.logDir, 'tts-api.err.log')
        轮转日志(logFile)
        轮转日志(errFile)
        const out = openSync(logFile, 'a')
        const err = openSync(errFile, 'a')
        apiChild = spawn(python, [script, '-a', '127.0.0.1', '-p', '9880'], {
          cwd: cfg.root,
          windowsHide: true,
          stdio: ['ignore', out, err],
          env: { ...process.env, MPLCONFIGDIR: cfg.mplConfigDir, PYTHONIOENCODING: 'utf-8' },
        })
        apiChild.on('exit', (code) => {
          say('GPT-SoVITS 进程退出：' + code)
          apiChild = null
          state.apiReady = false
          state.weightsOk = false
        })
      } catch (error) {
        say('启动 GPT-SoVITS 失败：' + (error && error.message))
        return false
      }
    }
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      if (await apiAlive()) {
        state.apiReady = true
        say('GPT-SoVITS 起来了')
        return true
      }
    }
    state.apiReady = false
    return false
  }

  /** 把 GPT / SoVITS 底模 / 爱莉希雅 LoRA 挨个装上（服务重启后要重装一次）。 */
  async function applyWeights() {
    if (state.weightsOk) return
    const steps = []
    if (cfg.gptWeights) steps.push(['set_gpt_weights', cfg.gptWeights])
    if (cfg.sovitsBase) steps.push(['set_sovits_weights', cfg.sovitsBase]) // LoRA 才需要底模
    if (cfg.sovitsWeights) steps.push(['set_sovits_weights', cfg.sovitsWeights])
    for (const [endpoint, path] of steps) {
      const r = await fetch(`${cfg.api}/${endpoint}?weights_path=${encodeURIComponent(abs(path))}`, {
        signal: AbortSignal.timeout(300000),
      })
      const t = (await r.text()).slice(0, 200)
      if (!r.ok || t.includes('"message":"error"')) throw new Error(`${endpoint} 失败：${t}`)
      say(`${endpoint} ← ${path.split(/[\\/]/).pop()}`)
    }
    state.weightsOk = true
  }

  let ensuring = null
  let readyAt = 0
  const ready = () => {
    // 刚确认过就不要再探活：合成时探活会超时，白跑一遍装权重。
    if (state.weightsOk && Date.now() - readyAt < 60000) return Promise.resolve(true)
    return (ensuring ||= (async () => {
      const ok = await ensureApi()
      if (!ok) return false
      await applyWeights()
      readyAt = Date.now()
      return true
    })().finally(() => (ensuring = null)))
  }

  /** 参数兜底：配置里写了非法值就回默认。 */
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

  /**
   * 最近合成过的音频（内存 LRU）。自动朗读几乎不会重复同一句，
   * 但试听、重复 /say、改语速后又改回来时可以直接复用。
   * key 覆盖参考音（含 mtime，换文件立即失效）、模型、语速和全部采样参数。
   */
  const cache = new Map()
  const CACHE_MAX = 8
  /** 流式整段的 PCM（squeeze 之后），命中时直接推给播放器。 */
  const streamCache = new Map()
  const STREAM_CACHE_MAX = 4
  const 音频钥匙 = (text) => {
    let stamp = 0
    try {
      const st = statSync(abs(cfg.refAudio))
      stamp = st.size + st.mtimeMs
    } catch {}
    return JSON.stringify([
      text,
      abs(cfg.refAudio),
      stamp,
      cfg.gptWeights,
      cfg.sovitsWeights,
      cfg.speed,
      cfg.temperature,
      cfg.topK,
      cfg.topP,
      cfg.seed,
    ])
  }
  const 落盘 = (buf) => {
    const file = join(tmpdir(), `elysia-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`)
    writeFileSync(file, buf)
    return file
  }

  /** 请求体：流式用 cut5（内部按标点切段） + raw PCM；非流式用 cut0 整句。 */
  const 合成参数 = (text, { split = 'cut0', stream = false } = {}) => {
    const seed = Number(cfg.seed)
    return {
      text,
      text_lang: cfg.textLang,
      ref_audio_path: abs(cfg.refAudio),
      prompt_text: cfg.promptText,
      prompt_lang: cfg.promptLang,
      text_split_method: split,
      batch_size: 1,
      media_type: stream ? 'raw' : 'wav',
      streaming_mode: stream,
      speed_factor: Number(cfg.speed) || 1,
      top_k: num(cfg.topK, 15),
      top_p: num(cfg.topP, 0.85),
      temperature: num(cfg.temperature, 0.8),
      sample_steps: Number(cfg.sampleSteps) || 8,
      parallel_infer: !!cfg.parallelInfer,
      repetition_penalty: 1.35,
      fragment_interval: num(cfg.fragmentInterval, 0.05),
      ...(Number.isInteger(seed) && seed >= 0 ? { seed } : {}),
    }
  }

  /** ffplay 公共参数：音量 + 不弹窗。 */
  const 播放参数 = () => ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(Math.max(0, Math.min(100, num(cfg.volume, 100))))]

  /** 起一个只读 stdin 的 ffplay（raw PCM），返回 child 与 done。 */
  function 开播放器(sr, signal) {
    const child = spawn(
      cfg.ffplay,
      [...播放参数(), '-f', 's16le', '-ar', String(sr || 32000), '-ch_layout', 'mono', '-i', 'pipe:0'],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    )
    state.playing = child
    const onAbort = () => {
      try {
        child.kill()
      } catch {}
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const done = new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (signal) signal.removeEventListener('abort', onAbort)
        if (state.playing === child) state.playing = null
        resolve()
      }
      child.on('exit', finish)
      child.on('error', finish)
    })
    return { child, done }
  }

  /** 往 ffplay 的 stdin 写一块 PCM，尊重背压。 */
  const 写PCM = (player, pcm) =>
    new Promise((resolve) => {
      const stdin = player.child.stdin
      if (!stdin || !stdin.writable) {
        resolve()
        return
      }
      const onError = () => resolve()
      stdin.once('error', onError)
      stdin.write(pcm, () => {
        stdin.removeListener('error', onError)
        resolve()
      })
    })

  /** 直接把一整段 PCM 播完（缓存命中时走这条）。 */
  async function 播PCM(pcm, sr, signal) {
    if (signal && signal.aborted) return
    const player = 开播放器(sr, signal)
    await 写PCM(player, pcm)
    try {
      player.child.stdin.end()
    } catch {}
    await player.done
  }

  /** 发一次 /tts；网络错误或 5xx 自动重试一次，4xx 和「已停止」不重试。 */
  async function 请求TTS(body, signal, retries = 1) {
    const timeout = AbortSignal.timeout(600000)
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal && signal.aborted) throw new Error('已停止')
      try {
        const r = await fetch(cfg.api + '/tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: sig,
        })
        if (r.ok) return r
        const detail = (await r.text()).slice(0, 200)
        const error = new Error('TTS HTTP ' + r.status + ' ' + detail)
        if (r.status < 500) {
          error.fatal = true
          throw error
        }
        lastError = error
      } catch (error) {
        if (signal && signal.aborted) throw error
        if (error && error.fatal) throw error
        lastError = error
      }
      if (attempt < retries) {
        say('TTS 请求失败，稍后重试：' + ((lastError && lastError.message) || lastError))
        await new Promise((r) => setTimeout(r, 600))
      }
    }
    throw lastError || new Error('TTS 请求失败')
  }

  async function synthesize(text, signal) {
    const key = 音频钥匙(text)
    const hit = cache.get(key)
    if (hit) {
      state.cacheHits++
      return 落盘(hit)
    }
    const r = await 请求TTS(合成参数(text, { split: 'cut0' }), signal)
    let buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 2000) throw new Error('TTS 返回的音频太小（' + buf.length + ' 字节）')
    if (cfg.trimSilence !== false) buf = 裁尾静音(buf, Number(cfg.sampleRate) || 32000)
    cache.set(key, buf)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return 落盘(buf)
  }

  function play(file, signal) {
    return new Promise((resolve) => {
      let settled = false
      let child = null
      const finish = () => {
        if (settled) return
        settled = true
        if (signal) signal.removeEventListener('abort', onAbort)
        state.playing = null
        try {
          rmSync(file, { force: true })
        } catch {}
        resolve()
      }
      const onAbort = () => {
        try {
          child?.kill()
        } catch {}
        finish()
      }
      if (signal && signal.aborted) {
        finish()
        return
      }
      if (signal) signal.addEventListener('abort', onAbort)
      try {
        child = spawn(cfg.ffplay, [...播放参数(), '-i', file], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch (error) {
        say('ffplay 起不来：' + (error && error.message))
        finish()
        return
      }
      state.playing = child
      child.on('exit', finish)
      child.on('error', finish)
    })
  }

  /**
   * 逐句模式（`streaming: false` 或流式失败时的退路）：切句 → 边合成边放，预取一句。
   */
  async function speakChunked(text, signal) {
    const sentences = 切句(text)
    if (!sentences.length) return
    const jobs = new Array(sentences.length)
    const 合成一句 = (i) => {
      if (i >= sentences.length || jobs[i]) return
      jobs[i] = (async () => {
        if (!(await ready())) throw new Error('GPT-SoVITS 没起来')
        if (signal.aborted) return { cancelled: true }
        const t0 = Date.now()
        const file = await synthesize(sentences[i], signal)
        say(`合成 ${((Date.now() - t0) / 1000).toFixed(1)}s：${sentences[i].slice(0, 26)}`)
        return { file }
      })().catch((error) => (signal.aborted ? { cancelled: true } : { error }))
    }
    try {
      for (let i = 0; i < sentences.length; i++) {
        if (signal.aborted) break
        合成一句(i)
        合成一句(i + 1)
        const r = await jobs[i]
        if (signal.aborted) break
        if (r.cancelled) break
        if (r.error) throw r.error
        await play(r.file, signal)
        if (signal.aborted) break
        state.spoken++
      }
    } finally {
      // 预取了但没播到的句子：把已经落盘的临时文件收掉。
      for (let j = 0; j < jobs.length; j++) {
        if (!jobs[j]) continue
        void jobs[j].then((r) => {
          if (r && r.file) rmSync(r.file, { force: true })
        })
      }
    }
  }

  /**
   * 流式模式：一次请求内部按标点切段（cut5），边生成边推进同一个 ffplay。
   * 只付一次每请求固定开销、只起一个播放器，第一段一出就能开口；
   * 顺手把 PCM 里超过 maxSilenceMs 的静音压短，避免每段自带的停顿堆起来。
   */
  async function speakStream(text, signal) {
    if (!(await ready())) throw new Error('GPT-SoVITS 没起来')
    const sr = Number(cfg.sampleRate) || 32000
    const key = 'stream:' + 音频钥匙(text)
    const hit = streamCache.get(key)
    if (hit) {
      state.cacheHits++
      say('缓存命中，直接放')
      await 播PCM(hit, sr, signal)
      if (!signal.aborted) state.spoken++
      return
    }
    const r = await 请求TTS(合成参数(text, { split: 'cut5', stream: true }), signal)
    if (!r.body) throw new Error('流式响应没有 body')

    const player = 开播放器(sr, signal)
    const squeeze = cfg.trimSilence !== false ? 静音压缩(sr, cfg.maxSilenceMs) : (c) => c
    const kept = []
    const queue = []
    let emitted = 0
    let generationDone = false
    let readerError = null
    let wake = null
    const kick = () => {
      const w = wake
      wake = null
      w?.()
    }
    const t0 = Date.now()
    // 读网络：一口气读完，不等播放器。否则「播放慢 → TCP 反压 → 生成也慢」，
    // 实测会把 40 秒的活儿拖成 50 秒。
    const reader = (async () => {
      for await (const chunk of r.body) {
        if (signal.aborted) break
        const pcm = squeeze(Buffer.from(chunk))
        if (!pcm.length) continue
        if (!emitted) say(`首段音频 +${((Date.now() - t0) / 1000).toFixed(1)}s`)
        emitted += pcm.length
        kept.push(pcm)
        queue.push(pcm)
        kick()
      }
    })()
      .catch((error) => {
        readerError = error
      })
      .finally(() => {
        generationDone = true
        kick()
      })

    // 写播放器：只受播放器自己的节奏限制，内存里排队的 PCM 由它慢慢吃。
    try {
      while (!generationDone || queue.length) {
        if (!queue.length) {
          await new Promise((resolve) => (wake = resolve))
          continue
        }
        await 写PCM(player, queue.shift())
        if (signal.aborted) break
      }
    } finally {
      try {
        player.child.stdin.end()
      } catch {}
      await player.done
      await reader
    }
    if (readerError) {
      const wrapped = new Error((readerError && readerError.message) || String(readerError))
      wrapped.partial = emitted > 0
      throw wrapped
    }
    if (signal.aborted || !emitted) return
    const pcm = Buffer.concat(kept)
    streamCache.set(key, pcm)
    if (streamCache.size > STREAM_CACHE_MAX) streamCache.delete(streamCache.keys().next().value)
    state.spoken++
    say(`流式播完 ${(emitted / 2 / sr).toFixed(1)}s 音频，总 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  }

  /**
   * 短回复：整段一次合成（服务端按 cut5 切段、拼成一个 wav），再整段播。
   * 首声会晚一点，但段间零空隙——一两句话的回复比流式更好听。
   */
  async function speakWhole(text, signal) {
    if (!(await ready())) throw new Error('GPT-SoVITS 没起来')
    const key = 'whole:' + 音频钥匙(text)
    let buf = cache.get(key)
    if (buf) {
      state.cacheHits++
      say('缓存命中（整段），直接放')
    } else {
      const t0 = Date.now()
      const r = await 请求TTS(合成参数(text, { split: 'cut5' }), signal)
      buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 2000) throw new Error('TTS 返回的音频太小（' + buf.length + ' 字节）')
      if (cfg.trimSilence !== false) buf = 裁尾静音(buf, Number(cfg.sampleRate) || 32000)
      cache.set(key, buf)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
      say(`整段合成 ${((Date.now() - t0) / 1000).toFixed(1)}s：${text.slice(0, 26)}`)
    }
    if (signal.aborted) return
    await play(落盘(buf), signal)
    if (!signal.aborted) state.spoken++
  }

  /** 对外只有这一个入口：短回复整段、否则流式；流式失败且没出过声就退回逐句。 */
  async function speak(text, signal) {
    const shortLimit = Number(cfg.shortReplyChars) || 0
    if (shortLimit > 0 && text.length <= shortLimit) {
      try {
        await speakWhole(text, signal)
        return
      } catch (error) {
        if (signal.aborted) return
        say('整段合成失败，改走流式：' + ((error && error.message) || error))
      }
    }
    if (cfg.streaming !== false) {
      try {
        await speakStream(text, signal)
        return
      } catch (error) {
        if (signal.aborted) return
        if (error && error.partial) throw error
        say('流式失败，退回逐句：' + ((error && error.message) || error))
      }
    }
    await speakChunked(text, signal)
  }

  let worker = null
  async function drain() {
    if (worker) return
    worker = (async () => {
      while (state.queue.length) {
        const item = state.queue.shift()
        if (item.epoch !== state.epoch) continue
        try {
          await speak(item.text, state.controller.signal)
        } catch (error) {
          if (state.controller.signal.aborted) break
          state.lastError = String((error && error.message) || error)
          say('这一段念失败：' + state.lastError)
        }
      }
      worker = null
      if (state.queue.length) void drain()
    })()
  }

  const enqueue = (text, { full = false } = {}) => {
    const cleaned = 去不能念的(text)
    // 右键「朗读选中」时，选中的是一整段，不该再按每轮 150 字截尾；
    // 但仍给个 2000 字上限，避免误选整页把引擎排爆。
    const clean = full ? cleaned.slice(0, 2000).trim() : 取预算(cleaned, cfg.maxChars, cfg.trim)
    if (!clean.trim()) return false
    if (state.queue.length >= cfg.maxQueue) {
      // 念不过来了：丢掉最早那段，保证听到的总是最新的回复。
      state.queue.shift()
      state.dropped++
      say(`队列满了，跳过更早的 1 段（累计跳过 ${state.dropped} 段）`)
    }
    state.queue.push({ text: clean, at: Date.now(), epoch: state.epoch })
    say('排队 ' + state.queue.length + ' 段：' + clean.slice(0, 40).replace(/\s+/g, ' '))
    void drain()
    return true
  }

  const scan = createScanner(
    (text) => {
      if (cfg.auto) enqueue(text)
    },
    (error, id) => say('读会话 ' + id + ' 出错：' + (error && error.message)),
  )

  ctx.effect(() =>
    ctx.interval(() => {
      try {
        // 子代理（origin: 'subagent'）的回复不念：那不是说给你听的话。
        const live = ctx.sessions.list().filter((s) => !(s.header && s.header.origin === 'subagent'))
        scan(live)
      } catch (error) {
        say('扫描出错：' + (error && error.message))
      }
    }, 1500),
  )

  // ---- 本机接口 ----
  /**
   * 只接受同源请求：别的小网页可以用 `<img src="/elysia-tts/say?text=...">` 触发朗读，
   * 浏览器会带 `Sec-Fetch-Site: cross-site`（或至少 Origin 对不上），这里直接挡掉。
   * curl / 本页 fetch 不受影响（不带这些头，或就是 same-origin）。
   */
  const 同源请求 = (req) => {
    if (cfg.sameSiteOnly === false) return true
    const site = String((req.headers && req.headers['sec-fetch-site']) || '')
    if (site && site !== 'same-origin' && site !== 'none') return false
    const origin = String((req.headers && req.headers.origin) || '')
    if (origin) {
      try {
        if (new URL(origin).host !== String((req.headers && req.headers.host) || '')) return false
      } catch {
        return false
      }
    }
    return true
  }

  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: P + path,
        handler: async (req, res) => {
          try {
            if (!同源请求(req)) {
              reply(res, 403, { ok: false, error: 'cross-site request blocked' })
              return
            }
            await handler(req, res)
          } catch (error) {
            reply(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    )

  route('/say', async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : {}
    const text = String(body.text || (new URL(req.url, 'http://x')).searchParams.get('text') || '')
    if (!text.trim()) {
      reply(res, 400, { ok: false, error: 'needs text' })
      return
    }
    const ok = enqueue(text, { full: body.full === true })
    reply(res, 200, { ok, queue: state.queue.length })
  })

  route('/status', async (_req, res) => {
    reply(res, 200, {
      ok: true,
      auto: cfg.auto,
      api: cfg.api,
      apiReady: state.apiReady,
      weightsOk: state.weightsOk,
      playing: state.playing !== null,
      queue: state.queue.length,
      spoken: state.spoken,
      dropped: state.dropped,
      cacheHits: state.cacheHits,
      lastError: state.lastError,
      refAudio: cfg.refAudio,
      promptText: cfg.promptText,
      sampleSteps: cfg.sampleSteps,
      speed: cfg.speed,
      maxChars: cfg.maxChars,
      trim: cfg.trim,
      style: cfg.style,
      streaming: cfg.streaming !== false,
      trimSilence: cfg.trimSilence !== false,
      maxSilenceMs: cfg.maxSilenceMs,
      sampleRate: Number(cfg.sampleRate) || 32000,
      temperature: num(cfg.temperature, 0.8),
      topK: num(cfg.topK, 15),
      topP: num(cfg.topP, 0.85),
      seed: Number(cfg.seed),
      volume: num(cfg.volume, 100),
      fragmentInterval: num(cfg.fragmentInterval, 0.05),
      shortReplyChars: num(cfg.shortReplyChars, 60),
      sameSiteOnly: cfg.sameSiteOnly !== false,
      sovitsWeights: cfg.sovitsWeights,
    })
  })

  route('/stop', async (_req, res) => {
    const pending = state.queue.length
    state.queue = []
    state.epoch++ // 正在念的那一段自己会看到代号变了
    try {
      state.controller.abort()
    } catch {}
    state.controller = new AbortController()
    try {
      state.playing?.kill()
    } catch {}
    state.playing = null
    reply(res, 200, { ok: true, cleared: pending })
  })

  route('/config', async (req, res) => {
    if (req.method === 'POST') {
      const patch = await readJson(req)
      for (const key of Object.keys(DEFAULTS)) if (patch[key] !== undefined) cfg[key] = patch[key]
      state.weightsOk = false
      saveCfg(cfg)
    }
    const out = {}
    for (const key of Object.keys(DEFAULTS)) out[key] = cfg[key]
    reply(res, 200, { ok: true, config: out, path: CFG_PATH })
  })

  route('/presets', async (_req, res) => {
    const curRef = ACTIVE_PRESETS.find((p) => join(cfg.presetDir, p.file) === cfg.refAudio)
    const curModel = MODEL_PRESETS.find((p) => join(cfg.modelDir, p.file) === cfg.sovitsWeights)
    reply(res, 200, {
      ok: true,
      refs: ACTIVE_PRESETS.map((p) => ({
        id: p.id,
        emotion: p.emotion || '其他',
        text: p.text,
        dur: p.dur,
        current: curRef ? curRef.id === p.id : false,
      })),
      models: MODEL_PRESETS.map((p) => ({ id: p.id, label: p.label, current: curModel ? curModel.id === p.id : false })),
      styles: STYLES.map((s) => ({ id: s.id, label: s.label, current: cfg.style === s.id })),
      style: cfg.style,
      refAudio: cfg.refAudio,
      promptText: cfg.promptText,
      sovitsWeights: cfg.sovitsWeights,
    })
  })

  route('/preset', async (req, res) => {
    const body = await readJson(req)
    if (body.ref) {
      const p = ACTIVE_PRESETS.find((x) => x.id === body.ref)
      if (!p) {
        reply(res, 400, { ok: false, error: 'unknown ref preset' })
        return
      }
      cfg.refAudio = join(cfg.presetDir, p.file)
      cfg.promptText = p.text
      // 手动换参考音 = 离开语气档（参数不动），免得下拉框还写着「撒娇」
      if (!body.style) cfg.style = 'custom'
    }
    if (body.model) {
      const p = MODEL_PRESETS.find((x) => x.id === body.model)
      if (!p) {
        reply(res, 400, { ok: false, error: 'unknown model preset' })
        return
      }
      cfg.sovitsWeights = join(cfg.modelDir, p.file)
      state.weightsOk = false
    }
    if (body.style) {
      const s = STYLE_MAP.get(body.style)
      if (!s) {
        reply(res, 400, { ok: false, error: 'unknown style preset' })
        return
      }
      cfg.style = s.id
      cfg.temperature = s.params.temperature
      cfg.topK = s.params.topK
      cfg.topP = s.params.topP
      // 情绪来自参考音：带 refEmotion 的档顺手切到那一组的第一条
      const ref = s.refEmotion ? 代表参考音(s.refEmotion) : null
      if (ref) {
        cfg.refAudio = join(cfg.presetDir, ref.file)
        cfg.promptText = ref.text
      }
    }
    // 单独调任何一个采样参数 = 离开语气档，标成自定义
    if (body.temperature !== undefined || body.topK !== undefined || body.topP !== undefined || body.seed !== undefined) {
      if (body.temperature !== undefined) cfg.temperature = num(body.temperature, 0.8)
      if (body.topK !== undefined) cfg.topK = num(body.topK, 15)
      if (body.topP !== undefined) cfg.topP = num(body.topP, 0.85)
      if (body.seed !== undefined) cfg.seed = Number.isInteger(Number(body.seed)) ? Number(body.seed) : -1
      cfg.style = 'custom'
    }
    if (body.speed !== undefined) cfg.speed = Number(body.speed) || 1
    if (body.maxChars !== undefined) cfg.maxChars = Number(body.maxChars) || 150
    if (body.volume !== undefined) cfg.volume = Math.max(0, Math.min(100, Number(body.volume) || 100))
    if (body.shortReplyChars !== undefined) cfg.shortReplyChars = Math.max(0, Number(body.shortReplyChars) || 0)
    saveCfg(cfg)
    reply(res, 200, {
      ok: true,
      refAudio: cfg.refAudio,
      promptText: cfg.promptText,
      sovitsWeights: cfg.sovitsWeights,
      speed: cfg.speed,
      maxChars: cfg.maxChars,
      volume: cfg.volume,
      shortReplyChars: cfg.shortReplyChars,
      style: cfg.style,
      temperature: cfg.temperature,
      topK: cfg.topK,
      topP: cfg.topP,
    })
  })

  route('/auto', async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams
    const raw = q.get('on') ?? q.get('enabled')
    if (raw !== null) cfg.auto = !/^(0|false|off|no)$/i.test(raw)
    else if (req.method === 'POST') {
      const body = await readJson(req)
      if (body.auto !== undefined) cfg.auto = !!body.auto
    } else cfg.auto = !cfg.auto
    saveCfg(cfg)
    reply(res, 200, { ok: true, auto: cfg.auto })
  })

  route('/warmup', async (_req, res) => {
    const ok = await ready().catch((error) => {
      state.lastError = String(error.message || error)
      return false
    })
    reply(res, 200, { ok, weightsOk: state.weightsOk, lastError: state.lastError })
  })

  // 把端口写进配置：桌面端每次启动端口都会变，外面的小工具靠它找回来
  try {
    if (ctx.webServer && typeof ctx.webServer.port === 'number') {
      cfg.port = ctx.webServer.port
      cfg.api = cfg.api || 'http://127.0.0.1:9880'
      saveCfg(cfg)
    }
  } catch {}

  // 插件卸载 / DSH 退出时把「自己拉起来的」引擎一起带走，别留下常驻进程。
  ctx.effect(() => () => {
    try {
      apiChild?.kill()
    } catch {}
    apiChild = null
  })

  // 起来就在背后把引擎热好（模型加载要 1~2 分钟，别等到第一句话才等）
  setTimeout(() => {
    void ready().then(
      (ok) => say(ok ? '预热完成，可以说话了' : '预热没成功：' + state.lastError),
      (error) => say('预热出错：' + (error && error.message)),
    )
  }, 3000).unref?.()

  say('已加载；自动朗读=' + cfg.auto + '；参考音=' + cfg.refAudio)
}
