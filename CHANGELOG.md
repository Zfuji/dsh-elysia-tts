# Changelog

所有重要改动都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 SemVer。

## [Unreleased]

## [0.10.0] - 2026-10-27

### Changed

- **拆分 `lib/index.js`**：现在是 `text.js`（纯文本处理）、`scanner.js`（会话扫描）、`player.js`（ffplay 进程）、`tts.js`（三种朗读策略）、`routes.js`（本机接口）五个模块；`index.js` 只负责配置、引擎生命周期、队列和接线（1230 行 → 约 500 行）
- 测试命令改为同时跑 helpers 与 integration

### Added

- **oxlint + prettier**，CI 增加 lint 与格式检查（Node 22/24 双矩阵）
- **集成测试**新增：`/stop` 中断、队列满丢弃、缓存命中、流式失败退回逐句（共 20 个用例）
- `CHANGELOG.md`；打 `v*` tag 时由 `release.yml` 自动生成 Release
- Issue 模板（bug / feature）、PR 模板、`CONTRIBUTING.md`
- README 增加控制台截图与英文版（`README.en.md`）

## [0.9.0] - 2026-10-27

### Added

- 短回复（≤ `shortReplyChars`，默认 60 字）整段合成再播，段间零空隙
- 音量可调（40–100，ffplay `-volume`）
- 本机接口只接受同源请求，挡掉跨站 `<img>` 触发朗读
- `Ctrl+Shift+R`：读选中内容，没选中则停止
- 日志超过 5MB 自动轮转
- 集成测试：短/长路径、重试、鉴权、音量

### Changed

- `fragment_interval` 0.3 → 0.05（服务端段间静音）。同一段四句话实测音频 15.36s → 12.66s，段间停顿 4.81s → 2.84s
- `/tts` 请求失败自动重试一次（4xx 与「已停止」不重试）

### Fixed

- 播放器先于音频数据退出时，写 stdin 的 `EPIPE` 会把整段朗读流程打挂（CI 在 Linux 上抓到）

## [0.8.0] - 2026-10-27

### Added

- 语气档从 2 个扩到 8 个：稳定 / 自然 / 生动 / 撒娇 / 撩拨 / 调皮 / 温柔 / 平静
- 带情绪的档会同时切换对应情绪的参考音；手动换参考音会把语气标成「自定义」

## [0.7.0] - 2026-10-27

### Added

- 选中文字右键朗读（朗读选中 / 停止 / 复制），`/say` 支持 `full:true` 不按每轮字数截断

## [0.6.0] - 2026-10-27

### Added

- 流式播放：一次请求内部按标点切段（`cut5`）→ raw PCM → 单个 ffplay
- 流式静音压缩（>200ms 压到 200ms）、裁尾静音、流式整段缓存

## [0.5.0] - 2026-10-27

### Added

- 39 条情绪参考音预设（`presets.json`，不入库）、`presets.example.json`
- 采样参数与语气档（`temperature` / `topK` / `topP` / `seed` / `style`）、内存 LRU 缓存
- 引擎探活容错（合成期间不再误判「引擎挂了」）

## [0.4.0] - 2026-10-27

### Fixed

- `/stop` 真正中断当前朗读（代号 + `AbortController`）
- 跳过子代理会话；长回复取尾部而非开头；队列满时明确记录丢弃
- 句间预取；45 字硬切；临时 wav 清理；跨站接口风险

## [0.3.0] - 2026-10-27

### Added

- 首个可用版本：会话监听、按句合成、ffplay 播放、🐳 控制台
