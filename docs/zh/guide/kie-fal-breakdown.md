# 使用 KIE / fal 拉片与生成

本改造基于 Hypit `67c15455`（0.3.1）。适合本地单用户短剧研究：读取原片、整理角色与剧情、逐镜复核、为复刻准备提示词。拉片结束后不会触发生图、视频生成或配音。

## Hypit 原来如何拉片

`skills/hypit/references/creation/reference-video.md` 要求 Agent 观看原片、读取转写、检查密集帧网格，再编写 `ANALYSIS.md` 和 `TIMELINE.md`。`@hypit/media-local` 提供探测、裁切、抽帧、网格和视觉边界工具；`hypit transcribe` 默认走 Runtime 选择的 WhisperX。它原本没有一个自动把短剧转换成逐镜语义表的 API。

拉片得到的关系和表达方式，由 Agent 转为 Script、SVS、SVML 和 SVRun；Runtime 执行显式选择的生成 Provider 和本地合成。这里的核心是证据、导演判断和可编辑的语义时间线。机械切点不等于叙事段落，词级对齐也不等于画面人物归属。

本次新增两个包：

- `packages/provider-kie-fal`：Hypit 原生 Endpoint Provider，支持 Runtime 配置、凭据引用、任务回执、查询、下载与结果封装。
- `packages/breakdown`：`hypit breakdown` 命令，复用原生本地媒体工具，建立可恢复的 API 分析流程与离线报告。

## 本地拉片

前置条件：Node ≥22.15、pnpm、ffmpeg/ffprobe，以及所选服务的 API key。源码目录执行 `pnpm install --frozen-lockfile`。不要把 key 写进 Source、Runtime JSON 或 Git。

```bash
export KIE_API_KEY='your-kie-key'
export FAL_KEY='your-fal-key'

# KIE 视觉分析，fal 托管媒体及转写
node bin/hypit.mjs breakdown /path/to/source.mp4 \
  --to /path/to/analysis --analysis-provider kie --allow-paid

# 显式选择 fal 视觉分析，仅需 FAL_KEY
node bin/hypit.mjs breakdown /path/to/source.mp4 \
  --to /path/to/analysis-fal --analysis-provider fal --allow-paid
```

支持不超过600秒的视频；更长原片应先分段。`--threshold 0.08` 控制 FFmpeg scene score，`--max-shots 100` 在付费前限制候选镜头数。分析模型可通过 `--model` 显式选择；默认 KIE `gemini-3-6-flash-openai`，fal `fal-ai/video-understanding`。跨 Provider 不自动切换。

链路：本地原片校验 → 逐解码帧切点候选 → 聚合间隔小于0.25秒的相邻峰值 → 本地音轨 → fal Scribe v2 独立词级转写 → 全片角色与节奏 → 每个独立镜头的视频分析 → 首中尾帧留证 → 时间覆盖和台词关联检查 → 报告。

KIE 接收独立镜头视频和3张采样图；fal 视频理解只接收连续视频，3张采样图保留供人工复核。fal 提示词有5000字符上限，转写会按说话轮次压缩；全片上下文过长时会明确截取，但独立词级转写完整保留。角色表过大时会在提交前拒绝该镜分析，避免静默截断人物。

## 输出与恢复

- `breakdown.json`：原片哈希、时间、角色、逐镜观察、剧情推断、复刻提示词、独立ASR词及跨镜关联。
- `ANALYSIS.md`、`TIMELINE.md`：符合 Hypit 参考片分析约定的笔记。
- `report.html`：内嵌首中尾图，附原片跳转播放。与 `source.mp4` 放在同目录可播放原片。
- `evidence/shot-*/`：镜头视频和3张原片采样帧；`contact-sheet.jpg` 为镜头中帧预览。
- `cuts.json` 保留所有原始机械候选；聚合后的镜头若包含候选，报告会标记复核。
- `.receipts/`、`.uploads/`、`.identity.json` 是私有恢复状态，可能含临时媒体链接，交付报告时不要打包这些目录。

相同命令和输出目录可恢复：已保存分析直接复用；已受理远程任务只查询原ID。同步请求丢失回执、POST结果不明时会停止，不能直接清除记录后重发。应先核对服务端日志。原片、模型、阈值或账号变化须使用新目录。

执行时 `.run.lock` 防止同目录并发。异常退出如留下锁，先读取锁的 PID 并确认对应进程已结束，再人工移除这一份锁；不要移除仍在执行的任务锁。

台词时间线独立保存，一个词跨越切点时可关联两个镜头，原始词只存一次。声音组不会自动认定为画面角色。镜头事实、剧情推断、生成提示词分别保存。

## 为 Hypit 生成步骤选择 API

示例 Runtime 在 `examples/kie-fal.runtime.json`。该 Profile 显式选用环境变量凭据，不修改原默认 Profile。

| Provider | 原生 Capability | 服务端模型 |
| --- | --- | --- |
| kie | `@hypit/nano-banana@1#nano-banana-2` | `nano-banana-2`，最多10张参考图 |
| fal | 同上 | `fal-ai/nano-banana-2` / `/edit`，jpg映射为jpeg |
| kie | `@hypit/seedance@1#seedance-2-mini` | `bytedance/seedance-2-mini`，不支持webSearch |
| fal | `@hypit/grok-imagine@1#grok-imagine-video` | `xai/grok-imagine-video/text-to-video` / `image-to-video`，最多1张参考图，480p/720p |

Provider 的 `supports` 在计划时拒绝不支持的输入；付费 POST 不自动重试，回执先 checkpoint；只对已有任务做只读查询。输出下载不会向媒体域名转发 API key。现阶段没有声明支持 KIE/fal 市场上的全部模型。

后续创作仍需把已复核结果变成目标 Script、Source 和 Run，再显式执行生成。这次拉片命令不自动写入可直接生成的完整 SVML，也不自动做配音和成片。

## 已知边界

机械候选仍可能漏切或误切；模型会误认衣服、动作、文字和人物。提示词、完整时间覆盖与结构校验不等于语义准确率验收。每次输出标记为待人工复核，开发自测不能替代独立QA。

原始素材和key不进Git；只在用户授权的 KIE/fal 账号内分析。改造沿用仓库 LICENSE，不改变 Hypit 的托管服务和商业分发许可条件。

接口资料：

- [KIE Gemini OpenAI兼容接口](https://docs.kie.ai/market/gemini/gemini-3-6-flash-openai)
- [KIE Nano Banana 2](https://docs.kie.ai/market/google/nanobanana2)
- [KIE Seedance Mini](https://docs.kie.ai/market/bytedance/seedance-2-mini)
- [fal 视频理解](https://fal.ai/models/fal-ai/video-understanding/api)
- [fal Scribe v2](https://fal.ai/models/fal-ai/elevenlabs/speech-to-text/scribe-v2/api)
- [fal Nano Banana 2](https://fal.ai/models/fal-ai/nano-banana-2/api)
- [fal Grok图生视频](https://fal.ai/models/xai/grok-imagine-video/image-to-video/api)
