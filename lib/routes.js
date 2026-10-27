/**
 * 本机 HTTP 接口：状态、朗读、停止、配置、预设、预热。
 * 全部只监听 127.0.0.1，并且默认只接受同源请求。
 * @module dsh-elysia-tts/lib/routes
 */
import { join } from 'node:path'

/** 响应头。 */
export const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
}

/**
 * 只接受同源请求：别的小网页可以用 `<img src="/elysia-tts/say?text=...">` 触发朗读，
 * 浏览器会带 `Sec-Fetch-Site: cross-site`（或至少 Origin 对不上），这里直接挡掉。
 * curl / 本页 fetch 不受影响（不带这些头，或就是 same-origin）。
 * @param {{headers?: Record<string, any>}} req
 * @param {boolean} sameSiteOnly
 */
export function 同源请求(req, sameSiteOnly) {
  if (sameSiteOnly === false) return true
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

/**
 * @param {object} ctx DSH 插件上下文（只用 webServer）
 * @param {object} deps
 * @param {string} deps.P 接口前缀
 * @param {Record<string, any>} deps.cfg
 * @param {Record<string, any>} deps.state
 * @param {Record<string, any>} deps.DEFAULTS
 * @param {string} deps.CFG_PATH
 * @param {(res: any, code: number, obj: unknown) => void} deps.reply
 * @param {(req: any) => Promise<any>} deps.readJson
 * @param {(cfg: any) => void} deps.saveCfg
 * @param {(v: unknown, d: number) => number} deps.num
 * @param {() => Promise<boolean>} deps.ready
 * @param {(text: string, opts?: {full?: boolean}) => boolean} deps.enqueue
 * @param {{ACTIVE_PRESETS: any[], MODEL_PRESETS: any[], STYLES: any[], STYLE_MAP: Map<string, any>, 代表参考音: (emotion: string) => any}} deps.presets
 */
export function registerRoutes(ctx, deps) {
  const { P, cfg, state, DEFAULTS, CFG_PATH, reply, readJson, saveCfg, num, ready, enqueue, presets } = deps
  const { ACTIVE_PRESETS, MODEL_PRESETS, STYLES, STYLE_MAP, 代表参考音 } = presets

  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: P + path,
        handler: async (req, res) => {
          try {
            if (!同源请求(req, cfg.sameSiteOnly)) {
              reply(res, 403, { ok: false, error: 'cross-site request blocked' })
              return
            }
            await handler(req, res)
          } catch (error) {
            reply(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        }
      })
    )

  route('/say', async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : {}
    const text = String(body.text || new URL(req.url, 'http://x').searchParams.get('text') || '')
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
      sovitsWeights: cfg.sovitsWeights
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
        current: curRef ? curRef.id === p.id : false
      })),
      models: MODEL_PRESETS.map((p) => ({ id: p.id, label: p.label, current: curModel ? curModel.id === p.id : false })),
      styles: STYLES.map((s) => ({ id: s.id, label: s.label, current: cfg.style === s.id })),
      style: cfg.style,
      refAudio: cfg.refAudio,
      promptText: cfg.promptText,
      sovitsWeights: cfg.sovitsWeights
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
      topP: cfg.topP
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
}
