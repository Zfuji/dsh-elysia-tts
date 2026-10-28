// dsh-elysia-tts · 宿主半边
// 盯住 DSH 里活着的会话 → 每说完一整轮，就把文字送去本地 GPT-SoVITS 合成，然后用 ffplay 放出来。
//
// 结构：这个文件只做「配置 + 引擎生命周期 + 队列 + 接线」。
//   text.js    纯文本处理（清理 / 切句 / 预算 / 静音裁剪）
//   scanner.js 会话事件扫描
//   player.js  ffplay 进程（整段 wav 或 raw PCM 管道）
//   tts.js     三条朗读策略（整段 / 流式 / 逐句）+ 缓存 + 重试
//   routes.js  本机 HTTP 接口
//
// 设计取舍：不做网页半边。DSH 桌面端就跑在这台机器上，宿主放声 = 你听得到。
// CPU 推理比播放慢（实测 RTF≈1.6–2.0），所以短回复整段合成、长回复流式、并压缩静音。

import { mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { createPlayer } from './player.js'
import { createTts } from './tts.js'
import { registerRoutes, HEADERS } from './routes.js'
import * as text from './text.js'
import { createScanner } from './scanner.js'

export { 去不能念的, 切句, 取预算, 切块, 裁尾静音, 静音压缩 } from './text.js'
export { createScanner } from './scanner.js'

export const name = 'elysia-tts'
export const inject = ['sessions', 'timer', 'webServer']

const P = '/elysia-tts'
const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const CFG_PATH = join(CFG_DIR, 'elysia-tts.json')

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
  /** 读文件：单次最多读多少字、每块多少字（块太小会多付每请求固定开销）。 */
  readMaxChars: 20000,
  readChunkChars: 600,
  /** 只接受同源请求（拦掉别的小网页用 <img> 触发 /say）。 */
  sameSiteOnly: true,
  autoStart: true,
  ffplay: 'ffplay',
  maxQueue: 3,
  maxChars: 150,
  /** 超长回复取哪一头念：tail=只念结论，head=念开场。 */
  trim: 'tail',
  mplConfigDir: 'D:\\GPT-SoVITS\\.mplconfig',
  logDir: 'D:\\GPT-SoVITS\\logs'
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
  { id: 'r3', emotion: '撒娇', label: '撒娇 · 示例 3', file: 'ref-sweet.wav', text: '撒娇的参考音台词。' }
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
  { id: 'calm', label: '平静', params: { temperature: 0.7, topK: 10, topP: 0.8 } }
]
const STYLE_MAP = new Map(STYLES.map((s) => [s.id, s]))
const 代表参考音 = (emotion) => ACTIVE_PRESETS.find((p) => p.emotion === emotion)

/** SoVITS 版本预设：同一批数据训出来的两个存档点。 */
const MODEL_PRESETS = [
  { id: 'e16', label: 'e16 · 稳一些', file: 'Elysia_v2_e16_s8720.pth' },
  { id: 'e24', label: 'e24 · 学得更久', file: 'Elysia_v2_e24_s13080.pth' }
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
    /** 读文件任务：{ id, name, total, done }，没有任务时为 null。 */
    read: null,
    /** 每次 /stop 自增：老的合成/播放循环看到代号变了就收手。 */
    epoch: 0,
    controller: new AbortController()
  }

  const reply = (res, code, obj) => {
    res.writeHead(code, HEADERS)
    res.end(JSON.stringify(obj))
  }
  const readJson = (req, limit = 200000) =>
    new Promise((resolve) => {
      let raw = ''
      let tooBig = false
      req.on('data', (c) => {
        raw += c
        if (raw.length > limit) {
          tooBig = true
          req.destroy()
        }
      })
      req.on('end', () => {
        if (tooBig) {
          resolve({ __tooBig: true })
          return
        }
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const abs = (p) => (isAbsolute(p) ? p : join(cfg.root, p))
  /** 参数兜底：配置里写了非法值就回默认。 */
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

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
          env: { ...process.env, MPLCONFIGDIR: cfg.mplConfigDir, PYTHONIOENCODING: 'utf-8' }
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
        signal: AbortSignal.timeout(300000)
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

  // ---- 播放 / 合成 ----
  const player = createPlayer({ cfg, state, say, num })
  const tts = createTts({ cfg, state, say, num, abs, player, text, ready })

  let worker = null
  async function drain() {
    if (worker) return
    worker = (async () => {
      while (state.queue.length) {
        const item = state.queue.shift()
        if (item.epoch !== state.epoch) continue
        try {
          await tts.speak(item.text, state.controller.signal)
        } catch (error) {
          if (state.controller.signal.aborted) break
          state.lastError = String((error && error.message) || error)
          say('这一段念失败：' + state.lastError)
        }
        // 读文件任务：念完一块推进度；念完最后一块就把任务标成完成
        if (item.job && state.read && state.read.id === item.job) {
          state.read.done++
          if (state.read.done >= state.read.total) state.read.finished = true
        }
      }
      worker = null
      if (state.queue.length) void drain()
    })()
  }

  /**
   * 排队一段话。
   * @param {string} 原文
   * @param {{full?: boolean, job?: string|null}} [options]
   *   `full` 不按每轮字数截尾；`job` 是读文件的任务 id（不参与「队列满丢最早」）
   */
  const enqueue = (原文, { full = false, job = null } = {}) => {
    const cleaned = text.去不能念的(原文)
    // 右键「朗读选中」/读文件时，内容不该再按每轮 150 字截尾；
    // 但仍给个 2000 字上限，避免误选整页把引擎排爆。
    const clean = full ? cleaned.slice(0, 2000).trim() : text.取预算(cleaned, cfg.maxChars, cfg.trim)
    if (!clean.trim()) return false
    // 自动朗读的旧逻辑：排满就丢最早的那段，保证听到最新回复；
    // 读文件是用户主动发起的，不丢，最多靠 readMaxChars 控制总量。
    if (!job && state.queue.length >= cfg.maxQueue) {
      state.queue.shift()
      state.dropped++
      say(`队列满了，跳过更早的 1 段（累计跳过 ${state.dropped} 段）`)
    }
    state.queue.push({ text: clean, at: Date.now(), epoch: state.epoch, job })
    say('排队 ' + state.queue.length + ' 段：' + clean.slice(0, 40).replace(/\s+/g, ' '))
    void drain()
    return true
  }

  const scan = createScanner(
    (原文) => {
      if (cfg.auto) enqueue(原文)
    },
    (error, id) => say('读会话 ' + id + ' 出错：' + (error && error.message))
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
    }, 1500)
  )

  // ---- 本机接口 ----
  registerRoutes(ctx, {
    P,
    cfg,
    state,
    DEFAULTS,
    CFG_PATH,
    reply,
    readJson,
    saveCfg,
    num,
    ready,
    enqueue,
    say,
    presets: { ACTIVE_PRESETS, MODEL_PRESETS, STYLES, STYLE_MAP, 代表参考音 }
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
      (error) => say('预热出错：' + (error && error.message))
    )
  }, 3000).unref?.()

  say('已加载；自动朗读=' + cfg.auto + '；参考音=' + cfg.refAudio)
}
