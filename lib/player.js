/**
 * 播放器：ffplay 的进程管理。两条路径——整段 wav 文件，或边生成边吃的 raw PCM 管道。
 * @module dsh-elysia-tts/lib/player
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'

/**
 * @param {object} deps
 * @param {Record<string, any>} deps.cfg 运行时配置（读 `ffplay` / `volume`）
 * @param {{playing: import('node:child_process').ChildProcess|null}} deps.state 播放状态
 * @param {(msg: string) => void} deps.say 日志
 * @param {(v: unknown, d: number) => number} deps.num 数字兜底
 */
export function createPlayer({ cfg, state, say, num }) {
  /** ffplay 公共参数：音量 + 不弹窗。 */
  const 播放参数 = () => ['-nodisp', '-autoexit', '-loglevel', 'error', '-volume', String(Math.max(0, Math.min(100, num(cfg.volume, 100))))]

  /**
   * 起一个只读 stdin 的 ffplay（raw PCM），返回 child 与 done。
   * @param {number} sr 采样率
   * @param {AbortSignal} [signal]
   */
  function 开播放器(sr, signal) {
    const child = spawn(cfg.ffplay, [...播放参数(), '-f', 's16le', '-ar', String(sr || 32000), '-ch_layout', 'mono', '-i', 'pipe:0'], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    // 播放器可能先于音频数据退出（比如参数不对、设备被占用）：吞掉 EPIPE，别让写管道炸掉整段流程。
    try {
      child.stdin.on('error', () => {})
    } catch {}
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

  /**
   * 往 ffplay 的 stdin 写一块 PCM；播放器提前退出（EPIPE）时安静放弃。
   * @param {{child: import('node:child_process').ChildProcess}} player
   * @param {Buffer} pcm
   * @returns {Promise<void>}
   */
  const 写PCM = (player, pcm) =>
    new Promise((resolve) => {
      const stdin = player.child.stdin
      if (!stdin || !stdin.writable || stdin.destroyed || player.child.exitCode !== null) {
        resolve()
        return
      }
      try {
        stdin.write(pcm, () => resolve())
      } catch {
        resolve()
      }
    })

  /**
   * 直接把一整段 PCM 播完（缓存命中时走这条）。
   * @param {Buffer} pcm
   * @param {number} sr
   * @param {AbortSignal} [signal]
   */
  async function 播PCM(pcm, sr, signal) {
    if (signal && signal.aborted) return
    const player = 开播放器(sr, signal)
    await 写PCM(player, pcm)
    try {
      player.child.stdin.end()
    } catch {}
    await player.done
  }

  /**
   * 播一个 wav 文件，播完删掉它。
   * @param {string} file
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
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
          stdio: 'ignore'
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

  return { 播放参数, 开播放器, 写PCM, 播PCM, play }
}
