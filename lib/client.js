// dsh-elysia-tts · 网页半边
// 右下角一个 🐳 小圆钮，点开是控制卡片：自动朗读开关、停止、换参考音 / 换版本 / 调语速、试听。
// 不依赖设置面板（这个 profile 里官方设置壳是关着的），直接往页面里挂 DOM，最稳。
window.__ModuleLoader__.load({
  id: 'dsh-elysia-tts',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    const B = '/elysia-tts'
    const get = (p) =>
      fetch(B + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null)
    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json())
        .catch(() => null)

    const CSS = `
      .dsh-elysia-fab{position:fixed;right:22px;bottom:96px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
        border:none;cursor:pointer;font-size:22px;line-height:1;background:rgba(255,236,244,.95);
        box-shadow:0 4px 18px rgba(0,0,0,.18);transition:transform .15s ease, box-shadow .15s ease}
      .dsh-elysia-fab:hover{transform:translateY(-2px);box-shadow:0 8px 22px rgba(0,0,0,.22)}
      .dsh-elysia-fab[data-playing=true]{animation:dsh-elysia-pulse 1.4s ease-in-out infinite}
      @keyframes dsh-elysia-pulse{0%,100%{box-shadow:0 4px 18px rgba(0,0,0,.18)}50%{box-shadow:0 0 0 8px rgba(255,150,190,.25),0 4px 18px rgba(0,0,0,.18)}}
      .dsh-elysia-panel{position:fixed;right:22px;bottom:152px;z-index:2147483000;width:308px;padding:14px;
        border-radius:14px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);
        box-shadow:0 10px 40px rgba(0,0,0,.22);font-size:13px;line-height:1.6;
        border:1px solid rgba(127,127,127,.18)}
      .dsh-elysia-panel h4{margin:0 0 8px;font-size:14px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
      .dsh-elysia-row{display:flex;justify-content:space-between;gap:8px;margin:6px 0;align-items:center}
      .dsh-elysia-row span:first-child{opacity:.7;white-space:nowrap}
      .dsh-elysia-btn{border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;border-radius:8px;
        padding:4px 10px;font-size:12px;cursor:pointer}
      .dsh-elysia-btn:hover{background:rgba(127,127,127,.1)}
      .dsh-elysia-btn[data-on=true]{background:rgba(255,150,190,.22);border-color:rgba(255,120,170,.5)}
      .dsh-elysia-panel select{max-width:168px;font-size:12px;padding:3px 6px;border-radius:7px;border:1px solid rgba(127,127,127,.25);
        background:transparent;color:inherit}
      .dsh-elysia-hint{opacity:.55;font-size:11.5px;margin-top:8px}
      .dsh-elysia-err{color:#d4380d;font-size:11.5px;margin-top:6px;word-break:break-all}
      .dsh-elysia-menu{position:fixed;z-index:2147483002;min-width:186px;padding:5px;border-radius:10px;
        background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);
        box-shadow:0 10px 32px rgba(0,0,0,.24);border:1px solid rgba(127,127,127,.18);font-size:13px;line-height:1.5}
      .dsh-elysia-menu button{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:7px;
        background:transparent;color:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
      .dsh-elysia-menu button:hover{background:rgba(127,127,127,.14)}
      .dsh-elysia-toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483003;
        padding:7px 14px;border-radius:999px;background:rgba(31,35,41,.88);color:#fff;font-size:12.5px;
        box-shadow:0 6px 20px rgba(0,0,0,.2);pointer-events:none;opacity:0;transition:opacity .18s ease}
      .dsh-elysia-toast[data-show=true]{opacity:1}
    `

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-elysia-tts'
        style.textContent = CSS
        document.head.appendChild(style)

        const fab = document.createElement('button')
        fab.className = 'dsh-elysia-fab'
        fab.title = '爱莉希雅朗读'
        fab.textContent = '🐳'
        document.body.appendChild(fab)

        const panel = document.createElement('div')
        panel.className = 'dsh-elysia-panel'
        panel.hidden = true
        panel.innerHTML = [
          '<h4><span>🐳 爱莉希雅朗读</span><button class="dsh-elysia-btn" data-act="close">收起</button></h4>',
          '<div class="dsh-elysia-row"><span>自动朗读</span><button class="dsh-elysia-btn" data-act="auto">开</button></div>',
          '<div class="dsh-elysia-row"><span>引擎</span><span data-k="engine">…</span></div>',
          '<div class="dsh-elysia-row"><span>现在</span><span data-k="now">待命</span></div>',
          '<div class="dsh-elysia-row"><span>参考音</span><select data-k="ref"></select></div>',
          '<div class="dsh-elysia-row"><span>语气</span><select data-k="style"></select></div>',
          '<div class="dsh-elysia-row"><span>音色档</span><select data-k="model"></select></div>',
          '<div class="dsh-elysia-row"><span>语速</span><select data-k="speed">',
          '<option value="0.9">0.9 慢一点</option><option value="1">1.0 正常</option>',
          '<option value="1.1">1.1 快一点</option><option value="1.2">1.2 很快</option></select></div>',
          '<div class="dsh-elysia-row"><span>每轮念</span><select data-k="maxChars">',
          '<option value="80">80 字</option><option value="150">150 字</option>',
          '<option value="260">260 字</option><option value="500">500 字</option></select></div>',
          '<div class="dsh-elysia-row" style="justify-content:flex-end;gap:8px">',
          '<button class="dsh-elysia-btn" data-act="test">试听</button>',
          '<button class="dsh-elysia-btn" data-act="stop">停止</button></div>',
          '<div class="dsh-elysia-err" data-k="err" hidden></div>',
          '<div class="dsh-elysia-hint">选中文字右键即可朗读。「撒娇 / 撩拨 / 调皮 / 温柔」会一起切换对应情绪的参考音。声音本地合成，不联网、不花钱。</div>',
        ].join('')
        document.body.appendChild(panel)

        // ---- 选中文字 → 右键朗读 ----
        const menu = document.createElement('div')
        menu.className = 'dsh-elysia-menu'
        menu.hidden = true
        document.body.appendChild(menu)

        const toast = document.createElement('div')
        toast.className = 'dsh-elysia-toast'
        document.body.appendChild(toast)
        let toastTimer = null
        const showToast = (text) => {
          toast.textContent = text
          toast.dataset.show = 'true'
          clearTimeout(toastTimer)
          toastTimer = setTimeout(() => (toast.dataset.show = 'false'), 1800)
        }

        let menuText = ''
        const hideMenu = () => {
          menu.hidden = true
        }
        const onContextMenu = (event) => {
          const sel = window.getSelection()
          const text = sel ? String(sel).trim() : ''
          // 没选中文字就交回浏览器原生菜单
          if (!text) {
            hideMenu()
            return
          }
          const target = event.target
          if (target instanceof Element) {
            // 输入框里右键通常是复制/粘贴，别抢
            if (target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
              hideMenu()
              return
            }
            if (target.closest('.dsh-elysia-panel, .dsh-elysia-fab, .dsh-elysia-menu')) {
              hideMenu()
              return
            }
          }
          event.preventDefault()
          menuText = text.slice(0, 2000)
          const count = menuText.length
          menu.replaceChildren()
          const item = (label, act) => {
            const b = document.createElement('button')
            b.dataset.act = act
            b.textContent = label
            menu.appendChild(b)
          }
          item(`🐳 朗读选中（${count} 字${text.length > count ? '，只念前 2000' : ''}）`, 'say')
          item('⏹ 停止朗读', 'stop')
          item('📋 复制选中', 'copy')

          menu.hidden = false
          const rect = menu.getBoundingClientRect()
          menu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8)) + 'px'
          menu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8)) + 'px'
        }

        const onMenuClick = async (event) => {
          const btn = event.target instanceof Element ? event.target.closest('button[data-act]') : null
          if (!btn) return
          const act = btn.dataset.act
          const text = menuText
          hideMenu()
          if (act === 'say') {
            if (!text) return
            const r = await post('/say', { text, full: true })
            showToast(r && r.ok ? `已送去朗读（${text.length} 字）` : '朗读失败：' + ((r && r.error) || '服务没响应'))
          } else if (act === 'stop') {
            await post('/stop')
            showToast('已停止')
          } else if (act === 'copy') {
            try {
              await navigator.clipboard.writeText(text)
              showToast('已复制')
            } catch {
              showToast('复制失败，试试 Ctrl+C')
            }
          }
        }

        const onDocPointerDown = (event) => {
          if (menu.hidden) return
          if (event.target instanceof Element && event.target.closest('.dsh-elysia-menu')) return
          hideMenu()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') hideMenu()
        }
        const onScroll = () => hideMenu()

        document.addEventListener('contextmenu', onContextMenu, true)
        document.addEventListener('pointerdown', onDocPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('scroll', onScroll, true)
        window.addEventListener('blur', hideMenu)
        menu.addEventListener('click', onMenuClick)

        const q = (sel) => panel.querySelector(sel)
        const setText = (k, v) => {
          const el = q(`[data-k="${k}"]`)
          if (el) el.textContent = v
        }
        let presets = null
        let presetSig = ''
        let state = null

        const fillPresets = (p) => {
          presets = p
          const refSel = q('[data-k="ref"]')
          const modelSel = q('[data-k="model"]')
          const styleSel = q('[data-k="style"]')
          // 轮询每 2 秒来一次，预设没变就别重建 DOM，
          // 否则用户正在挑参考音时下拉框会被清空、选中项会跳回去。
          const sig = JSON.stringify([p.refs || [], p.models || [], p.styles || []])
          if (sig === presetSig) return
          if (document.activeElement === refSel || document.activeElement === modelSel || document.activeElement === styleSel) return
          presetSig = sig
          refSel.innerHTML = ''
          // 按情绪分组：<optgroup label="开心">…
          const groups = new Map()
          for (const r of p.refs || []) {
            const key = r.emotion || '其他'
            if (!groups.has(key)) groups.set(key, [])
            groups.get(key).push(r)
          }
          for (const [emotion, list] of groups) {
            const group = document.createElement('optgroup')
            group.label = emotion
            for (const r of list) {
              const o = document.createElement('option')
              o.value = r.id
              const dur = Number(r.dur) > 0 ? `（${Number(r.dur).toFixed(1)}s）` : ''
              o.textContent = String(r.text || r.id).slice(0, 22) + dur
              if (r.current) o.selected = true
              group.appendChild(o)
            }
            refSel.appendChild(group)
          }
          modelSel.innerHTML = ''
          for (const m of p.models || []) {
            const o = document.createElement('option')
            o.value = m.id
            o.textContent = m.label
            if (m.current) o.selected = true
            modelSel.appendChild(o)
          }

          // 语气档由服务端给全量列表（撒娇 / 撩拨 / 调皮 / 温柔…会顺带切参考音）
          styleSel.innerHTML = ''
          const styles = p.styles && p.styles.length
            ? p.styles
            : [
                { id: 'stable', label: '稳定' },
                { id: 'lively', label: '生动' },
              ]
          for (const s of styles) {
            const o = document.createElement('option')
            o.value = s.id
            o.textContent = s.label
            if (s.current) o.selected = true
            styleSel.appendChild(o)
          }
          const custom = document.createElement('option')
          custom.value = 'custom'
          custom.textContent = '自定义'
          if (p.style === 'custom') custom.selected = true
          styleSel.appendChild(custom)
        }

        const render = () => {
          if (!state) return
          const autoBtn = q('[data-act="auto"]')
          autoBtn.textContent = state.auto ? '开' : '关'
          autoBtn.dataset.on = state.auto ? 'true' : 'false'
          fab.dataset.playing = state.playing ? 'true' : 'false'
          setText('engine', state.apiReady ? (state.weightsOk ? '就绪（爱莉希雅）' : '在起…') : '没启动')
          setText('now', state.playing ? '正在出声' : state.queue > 0 ? `排队 ${state.queue}` : `待命（已念 ${state.spoken} 段）`)
          const err = q('[data-k="err"]')
          if (state.lastError) {
            err.hidden = false
            err.textContent = state.lastError
          } else err.hidden = true
          const speedSel = q('[data-k="speed"]')
          if (document.activeElement !== speedSel && state.speed) speedSel.value = String(state.speed)
          const maxSel = q('[data-k="maxChars"]')
          if (document.activeElement !== maxSel && state.maxChars) maxSel.value = String(state.maxChars)
          const styleSel = q('[data-k="style"]')
          if (document.activeElement !== styleSel && state.style) styleSel.value = state.style
        }

        const refresh = async () => {
          const [s, p] = await Promise.all([get('/status'), presets ? Promise.resolve(presets) : get('/presets')])
          if (s && s.ok) state = s
          if (p && p.ok) fillPresets(p)
          render()
        }

        fab.addEventListener('click', () => {
          panel.hidden = !panel.hidden
          if (!panel.hidden) void refresh()
        })

        panel.addEventListener('click', async (event) => {
          const btn = event.target.closest('button[data-act]')
          if (!btn) return
          const act = btn.dataset.act
          if (act === 'close') {
            panel.hidden = true
            return
          }
          if (act === 'auto') {
            const next = !(state && state.auto)
            await post('/auto', { auto: next })
            await refresh()
            return
          }
          if (act === 'stop') {
            await post('/stop')
            await refresh()
            return
          }
          if (act === 'test') {
            btn.disabled = true
            await post('/say', { text: '你好呀，我是爱莉希雅。听见我的声音了吗？' })
            setTimeout(() => (btn.disabled = false), 1500)
            await refresh()
          }
        })

        panel.addEventListener('change', async (event) => {
          const sel = event.target.closest('select[data-k]')
          if (!sel) return
          const k = sel.dataset.k
          if (k === 'ref') await post('/preset', { ref: sel.value })
          else if (k === 'model') await post('/preset', { model: sel.value })
          else if (k === 'style') await post('/preset', { style: sel.value })
          else if (k === 'speed') await post('/preset', { speed: Number(sel.value) })
          else if (k === 'maxChars') await post('/preset', { maxChars: Number(sel.value) })
          await refresh()
        })

        const timer = setInterval(() => {
          if (!panel.hidden) void refresh()
        }, 2000)
        void refresh()

        return () => {
          clearInterval(timer)
          clearTimeout(toastTimer)
          document.removeEventListener('contextmenu', onContextMenu, true)
          document.removeEventListener('pointerdown', onDocPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('blur', hideMenu)
          fab.remove()
          panel.remove()
          menu.remove()
          toast.remove()
          style.remove()
        }
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
