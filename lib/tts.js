/**
 * 合成与朗读策略：整段（短回复）/ 流式（长回复）/ 逐句（退路）。
 *
 * 三条路径共用一套参数、缓存和播放器；选哪条由 `shortReplyChars` 和 `streaming` 决定。
 * @module dsh-elysia-tts/lib/tts
 */
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * @param {object} deps
 * @param {Record<string, any>} deps.cfg
 * @param {{cacheHits: number, spoken: number}} deps.state
 * @param {(msg: string) => void} deps.say
 * @param {(v: unknown, d: number) => number} deps.num
 * @param {(p: string) => string} deps.abs
 * @param {ReturnType<typeof import('./player.js').createPlayer>} deps.player
 * @param {typeof import('./text.js')} deps.text
 * @param {() => Promise<boolean>} deps.ready 引擎就绪（等模型加载完、权重装好）
 */
export function createTts({ cfg, state, say, num, abs, player, text, ready }) {
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
      cfg.seed
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
      ...(Number.isInteger(seed) && seed >= 0 ? { seed } : {})
    }
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
          signal: sig
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

  async function synthesize(内容, signal) {
    const key = 音频钥匙(内容)
    const hit = cache.get(key)
    if (hit) {
      state.cacheHits++
      return 落盘(hit)
    }
    const r = await 请求TTS(合成参数(内容, { split: 'cut0' }), signal)
    let buf = Buffer.from(await r.arrayBuffer())
    if (buf.length < 2000) throw new Error('TTS 返回的音频太小（' + buf.length + ' 字节）')
    if (cfg.trimSilence !== false) buf = text.裁尾静音(buf, Number(cfg.sampleRate) || 32000)
    cache.set(key, buf)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    return 落盘(buf)
  }

  /**
   * 逐句模式（`streaming: false` 或流式失败时的退路）：切句 → 边合成边放，预取一句。
   */
  async function speakChunked(内容, signal) {
    const sentences = text.切句(内容)
    if (!sentences.length) return
    const jobs = Array.from({ length: sentences.length })
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
        await player.play(r.file, signal)
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
  async function speakStream(内容, signal) {
    if (!(await ready())) throw new Error('GPT-SoVITS 没起来')
    const sr = Number(cfg.sampleRate) || 32000
    const key = 'stream:' + 音频钥匙(内容)
    const hit = streamCache.get(key)
    if (hit) {
      state.cacheHits++
      say('缓存命中，直接放')
      await player.播PCM(hit, sr, signal)
      if (!signal.aborted) state.spoken++
      return
    }
    const r = await 请求TTS(合成参数(内容, { split: 'cut5', stream: true }), signal)
    if (!r.body) throw new Error('流式响应没有 body')

    const 播放器 = player.开播放器(sr, signal)
    const squeeze = cfg.trimSilence !== false ? text.静音压缩(sr, cfg.maxSilenceMs) : (c) => c
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
        await player.写PCM(播放器, queue.shift())
        if (signal.aborted) break
      }
    } finally {
      try {
        播放器.child.stdin.end()
      } catch {}
      await 播放器.done
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
  async function speakWhole(内容, signal) {
    if (!(await ready())) throw new Error('GPT-SoVITS 没起来')
    const key = 'whole:' + 音频钥匙(内容)
    let buf = cache.get(key)
    if (buf) {
      state.cacheHits++
      say('缓存命中（整段），直接放')
    } else {
      const t0 = Date.now()
      const r = await 请求TTS(合成参数(内容, { split: 'cut5' }), signal)
      buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 2000) throw new Error('TTS 返回的音频太小（' + buf.length + ' 字节）')
      if (cfg.trimSilence !== false) buf = text.裁尾静音(buf, Number(cfg.sampleRate) || 32000)
      cache.set(key, buf)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
      say(`整段合成 ${((Date.now() - t0) / 1000).toFixed(1)}s：${内容.slice(0, 26)}`)
    }
    if (signal.aborted) return
    await player.play(落盘(buf), signal)
    if (!signal.aborted) state.spoken++
  }

  /** 对外只有这一个入口：短回复整段、否则流式；流式失败且没出过声就退回逐句。 */
  async function speak(内容, signal) {
    const shortLimit = Number(cfg.shortReplyChars) || 0
    if (shortLimit > 0 && 内容.length <= shortLimit) {
      try {
        await speakWhole(内容, signal)
        return
      } catch (error) {
        if (signal.aborted) return
        say('整段合成失败，改走流式：' + ((error && error.message) || error))
      }
    }
    if (cfg.streaming !== false) {
      try {
        await speakStream(内容, signal)
        return
      } catch (error) {
        if (signal.aborted) return
        if (error && error.partial) throw error
        say('流式失败，退回逐句：' + ((error && error.message) || error))
      }
    }
    await speakChunked(内容, signal)
  }

  return { synthesize, speakWhole, speakStream, speakChunked, speak }
}
