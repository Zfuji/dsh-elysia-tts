# 参与贡献

先读 [README.md](README.md) 和 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。这个仓库**只收代码**：模型权重、参考音、游戏台词、`lib/presets.json` 一律不入库（`.gitignore` 已挡）。

## 本地跑起来

```bash
git clone https://github.com/Zfuji/dsh-elysia-tts.git
cd dsh-elysia-tts

npm ci                                   # 只装 oxlint / prettier
cp lib/presets.example.json lib/presets.json   # 然后填你自己的参考音与台词

npm test                                 # helpers + integration，20 个用例
npm run lint                             # oxlint，要求 0 warning
npm run format:check                     # prettier
```

想真的听到声音，还需要：GPT-SoVITS 整合包、你自己的音色权重、`ffplay`（放 PATH），并在 `%DSH_HOME%\elysia-tts.json` 里配好路径。

## 代码结构

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 配置、引擎生命周期、队列、模块接线（入口） |
| `lib/text.js` | 纯文本：清理、切句、预算裁剪、静音裁剪（**最容易加测试**） |
| `lib/scanner.js` | 会话事件扫描，决定「哪一轮、哪条消息」该念 |
| `lib/player.js` | ffplay 进程（整段 wav / raw PCM 管道），音量、EPIPE 兜底 |
| `lib/tts.js` | 三条朗读策略（整段 / 流式 / 逐句）+ 参数 + 缓存 + 重试 |
| `lib/routes.js` | 本机 HTTP 接口，含同源校验 |
| `lib/client.js` | 网页半边：🐳 控制台、右键菜单、快捷键 |

## 改动的边界

- **不要**提交本机路径、真实参考音清单或任何游戏台词。
- **不要**为了让测试过而把 `presets.json` 塞进仓库——测试会自动回退到示例。
- 改听感相关逻辑（切句、静音、参数）时，PR 里附上实测：合成耗时、音频时长、段间空档。
- 新接口/新配置项要同步 README 与 CHANGELOG。

## 提交信息

用 `type: 一句话` 的形式，type 取 `feat` / `fix` / `refactor` / `docs` / `test` / `ci` / `chore`。正文里说清「为什么」，而不是复述 diff。

## 提交前

```bash
npm test && npm run lint && npm run format:check
```

CI 会在 Node 22 / 24 上跑同样的三件事，外加 `node --check`。

## 许可

提交代码即表示同意以 [MIT](LICENSE) 授权。第三方组件与角色素材的边界见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。
