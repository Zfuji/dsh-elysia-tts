# 致谢与来源说明 / Acknowledgments

本仓库**只包含插件代码**。模型权重、参考音、角色台词等素材都不随仓库分发，需要使用者自备。下面把「借了什么、来自哪里、许可如何」集中记在这里；插件本体许可见 [LICENSE](LICENSE)。

## 引擎与运行时

| 组件 | 作用 | 许可 | 是否随仓库分发 |
|---|---|---|---|
| [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) | 语音合成引擎。本插件通过它的 `api_v2.py` HTTP 服务推理：`/tts` 的 `text_split_method`、`text_lang`、`streaming_mode`、`media_type=raw`、`cut5` 分段等约定都来自它 | MIT | 否 |
| [FFmpeg / ffplay](https://ffmpeg.org/) | 播放；分析阶段用 `silencedetect` / `volumedetect` 量停顿和响度；服务端的 `speed_factor` 内部用 `atempo` 变速 | LGPL-2.1+ / GPL（取决于构建） | 否 |
| Node.js ≥ 22 | 运行时。只用内置模块（`node:fs`、`node:child_process`、`fetch`、`AbortSignal`），**没有第三方 npm 依赖** | MIT | 否 |
| [DeepSeek Harness](https://github.com/deepseek-ai) 的插件 API | 宿主能力：`sessions`、`webServer`、`timer`、客户端 `__ModuleLoader__`、`cordis.patch.yml`。按其插件开发文档实现 | 归属 DSH | 否 |

## 设计与实现上的参考

- **会话事件模型**：`turn/end`、`assistant/message`、`session.seq`（等于日志长度）、`snapshotEvents(from)` 的包含语义，均按 DSH 的 Session API 实现；子代理过滤用的是 `header.origin === 'subagent'`。
- **边生成边播**：流式 TTS → 播放器管线的思路来自业界常见做法；本项目的具体实现是自己写的——HTTP 流读满进内存队列、int16 静音压缩、单个 ffplay 从 stdin 持续消费，并且读网络不 `await` 播放器（否则会被 TCP 反压拖慢生成）。
- **参考音挑选经验**（3–7 秒、内部停顿 ≤0.5 秒、台词必须与音频逐字一致）来自 GPT-SoVITS 社区教程；「长停顿会被模仿成结巴」「文件名里的 ASR 错字会毁掉韵律」这两条是在本机实测验证的。
- **采样参数档位**（稳定 / 生动）的数值来自本项目自己的 A/B 实测，不是引用他人配置。

## 角色与素材

- 角色「爱莉希雅」及《崩坏3》相关内容的版权归 **miHoYo / HoYoverse** 及原配音演员所有。
- 音色模型与参考音来自社区分享的 GPT-SoVITS 爱莉希雅模型包（原始作者未署名），**不随本仓库分发**。
- 仓库里的 `lib/presets.example.json` 只有占位文本，不含任何游戏台词；真实清单 `lib/presets.json` 已 `.gitignore`。
- 请仅限个人学习使用：不要商用、不要二次传播模型或音频，也不要把合成结果用于冒充真人。

## 本项目的原创部分

- 会话扫描策略：只念完整成功的轮次、一轮只取最后一条有文字的助手消息、子代理跳过
- 句间预取、流式播放、`裁尾静音` / `静音压缩`（含跨 chunk 状态）
- 8 档语气，以及「情绪来自参考音而不是采样参数」的配对策略
- 选中文字右键朗读（`/say` 的 `full:true` 不截断）
- 发布前的脱敏与示例化、单测与 CI、README/性能数据整理

## 第三方许可的边界

插件本体以 **MIT** 发布。上表中各组件的许可各自独立：分发整合包、模型或音频时的义务不因本项目是 MIT 而豁免。如果在自己的产品里使用，请分别确认 GPT-SoVITS（MIT）、FFmpeg（LGPL/GPL）以及角色素材（miHoYo）的条款。
