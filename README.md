# dsh-elysia-tts

[![test](https://github.com/Zfuji/dsh-elysia-tts/actions/workflows/test.yml/badge.svg)](https://github.com/Zfuji/dsh-elysia-tts/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](package.json)

[中文](README.md) | [English](README.en.md)

给 DeepSeek Harness 的「爱莉希雅音色朗读」插件。宿主半边：盯住活着的会话 → 每说完一整轮 → 切成句子 → 送本地 GPT-SoVITS 合成 → 用 ffplay 在本机放出来。

![🐳 控制台与右键菜单](docs/panel.png)

> 只发布代码。模型权重、参考音和 `lib/presets.json` 不随仓库分发，需要自备（见「参考音预设」）。角色音色请仅限个人使用。

## 安装

在 DSH 的 profile（`%DSH_HOME%\profiles\<名字>\package.json`）里加依赖并把它加进 bundle 列表：

```jsonc
{
  "dependencies": {
    "dsh-elysia-tts": "https://codeload.github.com/Zfuji/dsh-elysia-tts/tar.gz/refs/heads/main"
  },
  "dsh": { "profile": { "bundles": ["…", "dsh-elysia-tts"] } }
}
```

装好重启 DSH，右下角会出现 🐳 按钮。本地开发时也可以直接 `link:D:/path/to/dsh-elysia-tts`。

前置条件：一份 GPT-SoVITS 整合包、你自己的音色权重、`ffplay`（放 PATH 里）、以及 `lib/presets.json`（从 `lib/presets.example.json` 复制一份来填）。

## 它怎么决定念什么

- 只念**完整说完且成功**（`turn/end` 且 `reason.kind === 'completed'`）的轮次；被打断、报错、被 fork 的轮次不念。
- 一轮可能有多个助手消息（工具调用的每一步一条）。只取**最后一条带文字的**那条：中间的「我先看看文件」之类过程独白不念。
- 子代理会话（`header.origin === 'subagent'`）整条跳过——那不是说给你听的话。
- 清理掉代码块、行内代码、链接、URL、HTML 标签、markdown 表格行、emoji 之后再念。
- **超长回复默认取尾部**（`trim: "tail"`）：长回答的开场白通常是「我先看看…」，结论在最后。想回到「只念开头」把 `trim` 改成 `"head"`。
- 每句最长 45 字（超过就在逗号处断，找不到逗号才硬切）。90 字一句要合成 40 秒以上，句间空档藏不住。

## 选中文字朗读（右键菜单）

在页面上选中任意一段文字 → 右键 → 菜单里有：

- **🐳 朗读选中（N 字）**：把选中内容送去合成，不受「每轮 150 字、只念尾部」的限制（上限 2000 字，防止误选整页）。
- **⏹ 停止朗读**：等于面板上的停止。
- **📋 复制选中**：因为原生右键菜单被我们接管了，补一个复制。

行为细节：

- 没选中文字时**不拦截**，原生菜单照旧；
- 在输入框 / 文本域 / contenteditable 里右键**不拦截**（那里更需要复制粘贴）；
- 点空白处、滚动、按 Esc、切窗口都会收起菜单；
- 每次操作底部弹一条小提示（已送去朗读 / 已停止 / 已复制）。
- 快捷键 **Ctrl+Shift+R**：有选中就读选中，没选中就停止。

## 读文件

面板里点「选择文件…」，选一个纯文本文件（txt / md / json / csv / log / srt / vtt / yaml / html），插件会：

1. 在浏览器里读出文字（上限 4MB），交给宿主；
2. 宿主机清理后按句子切成约 600 字一块（eadChunkChars），逐块排队朗读；
3. 面板「现在」显示 读文件 3/12，读完显示「读完「文件名」」；
4. 「停止」会清掉整个任务。

单次最多读 eadMaxChars（默认 20000 字，约 25 分钟合成时间），超出会截断并在提示里标出。读文件的任务**不参与**自动朗读的「队列满丢最早」，所以不会念到一半被新回复挤掉。

> Word / PDF 暂不支持：请先另存为 .txt 或复制成文本。原因是浏览器侧无法可靠抽文本，而宿主不想为此引入解析依赖。

## 延迟是怎么压的

CPU 推理比播放慢，实测 **RTF（合成耗时 / 音频时长）≈ 1.6–2.0**，这是物理墙。插件能做的是别在墙上再自己加延迟：

1. **短回复整段合成**：≤ `shortReplyChars`（默认 60 字）的回复一次合成整段再播，段间零空隙；长回复才走流式。一两句话时听感最好。
2. **流式播放**：一次请求内部按标点切段（`cut5`），边生成边推进**同一个** ffplay。实测首段 4.6 秒就到（逐句模式要 13.5 秒才开口），只付一次每请求固定开销、只起一个播放器。
3. **静音压缩**：模型每段自带 ~0.45 秒尾静音，段段累加就是死气。流式路径把超过 `maxSilenceMs`（默认 200ms）的连续静音压短；整段/逐句路径用 `裁尾静音` 剪掉 wav 尾巴。
4. **`fragment_interval` 0.3 → 0.05**：服务端在 cut5 每段之间会**插入 0.3 秒静音**。同一段四句话实测：总音频 15.36s → 12.66s，段间停顿 4.81s → 2.84s。
5. **网络读满、播放器自己消化**：读网络不 `await` 播放器，否则「播放慢 → TCP 反压 → 生成也慢」，实测会把 40 秒的活儿拖成 50 秒。
6. **语气档默认 `stable`**：`temperature=0.8 / top_k=15 / top_p=0.85`。想换回原来的听感，控制台里切「生动」即可。

`/stop` 用「代号 + AbortController」停播放、清队列、取消在飞的请求。

**为什么还是会有停顿**：RTF > 1 意味着「说完 9 秒的话要算 13~18 秒」，缺口必须落在某处——流式把它摊成一次次短停顿，逐句模式则是一个个大洞。想要真正像人说话，需要 RTF < 1（换 GPU / ONNX），这台机器纯 CPU 做不到。退而求其次：`maxChars` 调小（80 字 ≈ 一句话）、或听的时候别同时跑视频/编译。

**注意**：停止只停「播放」。服务端已经开始的推理不会中断（FastAPI 里是同步阻塞调用），那句会继续把 CPU 用完（实测停止后立刻再点一句，要等 ~14 秒才出声）。想彻底掐断只能重启引擎（重新加载模型 1~2 分钟）。

## 参考音预设

仓库里只带 `lib/presets.example.json`（3 条占位）。真正生效的 `lib/presets.json` **不入库**——它指向你自己的参考音和台词。复制示例改一份即可：

```jsonc
{
  "version": 1,
  "dir": "D:\\GPT-SoVITS\\refs",        // 参考音目录
  "presets": [
    { "id": "p01", "emotion": "普通", "label": "普通 · 开场", 
      "text": "这段参考音对应的台词（必须和音频逐字一致）",
      "file": "ref-normal.wav", "dur": 5.0 }
  ]
}
```

挑参考音的几条经验（都是实测踩出来的）：

- **3–7 秒**最稳；太长会拖慢每句的推理，太短学不到音色。
- **内部停顿 ≤0.5 秒**。长停顿会被模型模仿成"结巴"，句间空档也会变长。
- **台词必须逐字对上**。文件名里的 ASR 转写经常有错字（比如把「芽衣」写成「牙医」），文本一错，韵律和相似度都会塌。
- 别混入别的声线。同一份素材里如果混了其他角色的台词，选成 prompt 会直接换人。
- 情绪靠参考音而不是采样参数：不同情绪各放一条，控制台会按 `emotion` 分组，语气档里的「撒娇/撩拨/调皮/温柔」会自动挑对应组的第一条。

## 它依赖什么

- **GPT-SoVITS 整合包**（自带 Python 运行时），示例路径 `D:\GPT-SoVITS\GPT-SoVITS-v4-20250529`。v4 的包也能加载 v2/v3 训出来的模型。
- **你自己的音色模型**（自备，不随仓库分发）：
  - GPT 权重：`<模型目录>\GPT_weights\*.ckpt`
  - SoVITS 权重：`<模型目录>\SoVITS_weights\*.pth`
  - LoRA 模型才需要额外填 `sovitsBase` 底模
- **参考音 + 台词**：由 `lib/presets.json` 指定（见上一节）
- **`ffplay`**（ffmpeg 自带，放 PATH 里即可）负责放声

以上路径都在 `%DSH_HOME%\elysia-tts.json` 里改，或在控制台里点点点。

## 语气档

采样参数只决定「节奏 / 起伏」，真正决定情绪的是参考音。所以语气档分成两类：

| 档 | temperature / top_k / top_p | 是否切参考音 |
|---|---|---|
| 稳定 | 0.80 / 15 / 0.85 | 不动，保留你手选的参考音 |
| 自然 | 0.90 / 20 / 0.90 | 不动 |
| 生动 | 0.95 / 10 / 0.90 | 不动 |
| 撒娇 | 0.95 / 15 / 0.90 | 切到「撒娇」组第一条 |
| 撩拨 | 0.90 / 15 / 0.90 | 切到「撩拨」组第一条 |
| 调皮 | 1.00 / 20 / 0.90 | 切到「调皮」组第一条 |
| 温柔 | 0.75 / 15 / 0.85 | 切到「感动」组第一条 |
| 平静 | 0.70 / 10 / 0.80 | 不动 |

手动在下拉里单独换参考音、或单独改采样参数，都会把语气标成「自定义」（参数和参考音都不动）。想精确挑某一条参考音，先用「参考音」下拉，再回到语气档就是自定义状态。

## 配置

`%DSH_HOME%\elysia-tts.json`（默认 `C:\Users\<你>\.dsh\elysia-tts.json`），只写你想改的键，其余走默认值：

| 键 | 说明 |
|---|---|
| `auto` | 是否自动念每一轮回复 |
| `maxChars` | 每轮最多念多少字（默认 150；RTF>1 时调到 80 会明显更顺） |
| `trim` | 超长回复取哪头：`"tail"`（默认，念结论）/ `"head"`（念开场） |
| `streaming` | 是否流式播放（默认 `true`）。关掉退回「逐句请求 + 预取」，开口更晚但每句更完整 |
| `shortReplyChars` | 这么短的回复整段合成再播（默认 60 字），段间零空隙；`0` 关闭 |
| `readMaxChars` / `readChunkChars` | 读文件单次上限（默认 20000 字）/ 每块字数（默认 600） |
| `fragmentInterval` | 服务端 cut5 段间插入的静音秒数（默认 `0.05`）。API 默认 0.3，段段累加就是死气 |
| `volume` | 播放音量 0–100（默认 100），ffplay `-volume` |
| `sameSiteOnly` | 只接受同源请求（默认 `true`），挡掉别的小网页用 `<img>` 触发朗读 |
| `trimSilence` / `maxSilenceMs` | 是否压缩超长静音（默认开，200ms）。静音太长听着像掉线 |
| `sampleRate` | 合成采样率，v2 模型固定 `32000`。流式 PCM 没有文件头，必须和模型一致 |
| `gptWeights` / `sovitsWeights` | GPT / SoVITS 模型路径；`sovitsBase` 只有 LoRA 模型才需要（填底模） |
| `presetDir` / `refAudio` / `promptText` | 预设库目录 / 当前参考音 / 它对应的文字（必须逐字对得上） |
| `temperature` / `topK` / `topP` | 采样参数；默认 `0.8 / 15 / 0.85` |
| `seed` | `-1` 每句随机；`>=0` 固定种子，同一句输出完全可复现（调 bug 时有用） |
| `style` | 语气档：`stable` / `natural` / `lively` / `sweet` / `tease` / `playful` / `tender` / `calm` / `custom`。带情绪的档会顺带切参考音，见下表 |
| `speed` | 语速倍率（服务端用 ffmpeg `atempo`，保音高；但**不会减少合成耗时**，调快只会让句间空档更明显） |
| `sampleSteps` | v3/v4 扩散步数（v2 模型不用） |
| `maxQueue` | 最多排几轮；排满时丢掉**最早**那段并记 `dropped`，保证听到的总是最新回复 |
| `port` | 插件自己写回来的 DSH 端口，给外面的 .bat 用 |

## 本机接口

只监听 `127.0.0.1`，并且默认**只接受同源请求**（跨站的 `Sec-Fetch-Site` / `Origin` 对不上会回 403），避免别的小网页用 `<img src="…/say?text=">` 让她念奇怪的东西。

- `GET  /elysia-tts/status` 状态（`queue` / `spoken` / `dropped` / `cacheHits` / `style` / `volume` / `lastError` …）
- `POST /elysia-tts/say {"text":"…"}` 念一句；加 `"full": true` 则不按每轮字数截断（右键朗读走这条）
- `POST /elysia-tts/read {"name":"a.txt","text":"…"}` 读文件：切块排队，进度看 `/status` 的 `read`
- `POST /elysia-tts/stop` 停止播放 + 清队列
- `POST /elysia-tts/config {…}` 改配置（立刻生效并落盘）
- `POST /elysia-tts/auto` 开关自动朗读
- `POST /elysia-tts/warmup` 预热引擎
- `GET  /elysia-tts/presets` 参考音/音色档列表
- `POST /elysia-tts/preset {"ref":"p01"}` / `{"style":"lively"}` / `{"volume":60}` 切换

## 缓存

流式整段的 PCM 存 4 条、逐句模式的 wav 存 8 条，都在内存里（key 含文本、参考音路径 + mtime、模型、语速和全部采样参数）。自动朗读几乎不复用同一句，所以它主要省的是「试听」和重复 `/say`（实测第二遍 0.0 秒出声）。命中数看 `/status` 的 `cacheHits`。

## 性能（这台机器，无独显，CPU fp32）

| 场景 | 合成耗时 | 音频时长 |
|---|---|---|
| 2 字 | 2.4–2.6s | 0.4–0.9s |
| 17 字 | 10.7s | 5.18s |
| 23 字 · 生动 `0.95/10/0.9` | 13.0 / 16.7s | 7.42 / 8.46s |
| 23 字 · 稳定 `0.80/15/0.85` | 8.2 / 9.6s | 7.30 / 7.50s |
| 41 字 | 19.2s | 9.54s |
| 115 字（流式，三段） | 合计 ≈ 39s | 24.6s（裁静音后 22.7s） |

结论：每请求固定开销约 2.4 秒；RTF 空闲时 1.1–1.6、后台开着视频时能到 2.0–2.5；同一句话在松参数下输出时长能差 37%（拖长/结巴）。`parallel_infer: true` 没有稳定收益（13.1s vs 13.9s，被抖动吃掉）。e16/e24 速度没差别（22.3s vs 22.8s）。音量不用归一：9 个片段的 `mean_volume` 只在 −18.3 ~ −19.6 dB 之间（差 1.1dB，听不出）。

## 开发

```bash
npm ci                                   # 只装 oxlint / prettier
cp lib/presets.example.json lib/presets.json   # 填自己的参考音与台词

npm test          # helpers + integration，共 20 个用例
npm run lint      # oxlint，要求 0 warning
npm run format:check
```

代码结构：`index.js`（配置 / 引擎生命周期 / 队列 / 接线）、`text.js`（纯文本）、`scanner.js`（会话扫描）、`player.js`（ffplay）、`tts.js`（整段 / 流式 / 逐句 + 缓存 + 重试）、`routes.js`（本机接口）、`client.js`（网页半边）。细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

宿主半边的改动需要重启 DSH 才生效；网页半边（`lib/client.js`）的 bundle 也是启动时打包的，所以同样重启一次最稳——只有本地开着 `pnpm run dev:web` 时才会热更新。

## 参与

- 版本记录：[CHANGELOG.md](CHANGELOG.md)（打 `v*` tag 会自动生成 Release）
- 贡献指南与代码结构：[CONTRIBUTING.md](CONTRIBUTING.md)
- 来源与许可边界：[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)

## 致谢

本插件站在别人的肩膀上，完整来源与许可边界见 **[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)**：

- **GPT-SoVITS**（MIT）：合成引擎，`/tts` 的切段与语言约定都来自它。
- **FFmpeg / ffplay**：播放与音频分析。
- **DeepSeek Harness**：插件 API（会话、Web 服务、客户端模块加载器）。
- 角色「爱莉希雅」与音色素材版权归 **miHoYo / HoYoverse** 及原配音演员，模型与参考音不随仓库分发。

## 许可

MIT（插件本体，见 [LICENSE](LICENSE)）。模型、参考音与音色素材不随仓库分发，请自行准备并确认你有权使用；角色音色仅限个人使用，别商用、别二次传播。第三方组件的许可各自独立，详见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。

