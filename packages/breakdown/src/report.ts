import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Breakdown } from "./index.js";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export async function exportReports(root: string, result: Breakdown) {
  const analysis = ["# 原片拉片分析", "", result.roster.summary, "", `时长 ${result.source.duration} 秒；${result.shots.length} 个候选镜头；${result.words.length} 个ASR词。`, "", "## 角色档案", "",
    ...result.roster.characters.map(c => `- ${c.id}：${c.appearance}`), "", "## 剧情节奏（模型推断）", "", ...result.roster.storyBeats.map(s => `- ${s}`), "", "## 待复核", "", ...[...result.review, ...result.roster.uncertainties].map(s => `- ${s}`), "",
    "分析保留原片事实与复刻提示词；没有提交生图、视频生成或配音。人物编号和声音编号保持独立，后续需人工映射。", ""];
  const timeline = ["# 逐镜时间线", "", "时间为原片绝对秒；台词按时间重叠关联，相邻镜头可能引用同一词。完整词只在 breakdown.json 的 words 中保存一次。", ""];
  for (const shot of result.shots) {
    const a = shot.analysis;
    timeline.push(`## ${shot.start.toFixed(3)}–${shot.end.toFixed(3)} · ${shot.id}`, "", `地点：${a.location}`, `人物：${a.characters.join("、") || "无法确认"}`, `可见动作：${a.visibleAction}`, `摄影：${a.composition}`, `运镜：${a.cameraMotion}`, `画面文字：${a.onScreenText}`, `声音：${a.sound}`, `剧情作用（推断）：${a.narrativeInference}`, `连续性：${a.continuity}`, "", `台词（ASR）：${shot.wordIndices.map(i => result.words[i]!.text).join(" ") || "无"}`, "", `复刻提示词：${a.recreationPrompt}`, "", `证据：[片段](${shot.clip})；${shot.frames.map((f, i) => `[采样${i + 1} @${f.at.toFixed(3)}s](${f.path})`).join("；")}`, "", ...shot.review.map(s => `- 待复核：${s}`), "");
  }
  await writeFile(join(root, "ANALYSIS.md"), analysis.join("\n"));
  await writeFile(join(root, "TIMELINE.md"), timeline.join("\n"));
  const e = escapeHtml;
  const cards = [];
  for (const shot of result.shots) {
    const images = [];
    for (const f of shot.frames) images.push(`<figure><img src="data:image/jpeg;base64,${(await readFile(join(root, f.path))).toString("base64")}" alt="${e(shot.id)} @${f.at.toFixed(3)}秒"><figcaption>${f.at.toFixed(3)}s</figcaption></figure>`);
    const a = shot.analysis;
    cards.push(`<article id="${shot.id}"><h2>${e(shot.id)} · ${shot.start.toFixed(3)}–${shot.end.toFixed(3)}秒</h2><button data-start="${shot.start}">从此镜头播放原片</button><div class="frames">${images.join("")}</div><p><b>地点</b> ${e(a.location)} · <b>人物</b> ${e(a.characters.join(" / ") || "无法确认")}</p><p>${e(a.visibleAction)}</p><p><b>摄影</b> ${e(a.composition)}<br><b>运镜</b> ${e(a.cameraMotion)}<br><b>连续性</b> ${e(a.continuity)}</p><p><b>台词 · ASR</b> ${e(shot.wordIndices.map(i => result.words[i]!.text).join(" ") || "无")}</p><details><summary>复刻提示词与推断</summary><p>${e(a.recreationPrompt)}</p><p>剧情推断：${e(a.narrativeInference)}</p><p>画面文字：${e(a.onScreenText)}</p><p>声音：${e(a.sound)}</p></details>${shot.review.length ? `<p class="review">待复核：${shot.review.map(e).join("；")}</p>` : ""}</article>`);
  }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hypit 短剧拉片</title><style>body{margin:0;background:#10151b;color:#edf2f7;font:16px/1.7 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:24px}h1{margin-bottom:0}h2{font-size:21px}header,article{background:#1a232e;border:1px solid #344356;border-radius:12px;padding:24px;margin:24px 0}video{width:100%;max-height:420px;background:#05080b}.frames{display:flex;gap:12px;margin:16px 0}figure{margin:0;flex:1;min-width:0}img{width:100%;max-height:480px;object-fit:contain;background:#080c12}figcaption{color:#b7c8dd;font-size:14px}button{background:#b7eddb;color:#10221b;border:0;border-radius:6px;padding:9px 16px;cursor:pointer;font:inherit}a{color:#b7eddb}.review{color:#f5d393}summary{cursor:pointer}@media(max-width:600px){main{padding:12px}header,article{padding:14px}.frames{gap:5px}h2{font-size:18px}}</style><main><h1>Hypit · 短剧拉片</h1><p>${result.source.duration}秒 / ${result.shots.length}候选镜头 / ${result.roster.characters.length}角色记录 / ${result.words.length}ASR词</p><p class="review">真实API分析 · 需人工复核 · 未提交后续生成</p><header><p>${e(result.roster.summary)}</p><video id="source" controls preload="metadata" src="source.mp4"></video><p>视频需与本文件同目录的 source.mp4；图片已内嵌，单独打开也可查看。</p><p>${result.review.map(e).join("；")}</p><details><summary>角色档案与剧情节奏</summary>${result.roster.characters.map(c => `<p><b>${e(c.id)}</b> ${e(c.appearance)}</p>`).join("")}<p>${result.roster.storyBeats.map(e).join("<br>")}</p></details></header>${cards.join("")}</main><script>document.querySelectorAll('button[data-start]').forEach(b=>b.addEventListener('click',()=>{const v=document.getElementById('source');v.currentTime=Number(b.dataset.start);v.play().catch(()=>{});v.scrollIntoView({behavior:'smooth',block:'center'});}));</script></html>`;
  await writeFile(join(root, "report.html"), html);
}
