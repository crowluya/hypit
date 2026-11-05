import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cutClip, cutFrame, probeMedia, tileFrames } from "@hypit/media-local/files";
import { CloudClient, analysisJson, publicUrl } from "@hypit/provider-kie-fal/client";
import { digest, Ledger, readJson, saveJson } from "./ledger.js";
import { consolidateCuts, intervals, overviewPrompt, parseRoster, parseShot, parseWords, sampleTimes, shotPrompt, speechLinks } from "./analysis.js";
import type { Interval, Roster, ShotAnalysis, Word } from "./analysis.js";
import { exportReports } from "./report.js";

const execute = promisify(execFile);
export type BreakdownShot = Interval & { analysis: ShotAnalysis; clip: string; frames: { path: string; at: number }[]; wordIndices: number[]; review: string[] };
export type Breakdown = {
  format: "hypit.breakdown@1"; source: { file: string; sha256: string; duration: number; videoDuration: number; width: number; height: number; frameRate: number };
  provenance: { method: string; model: string; createdAt: string; generationSubmitted: false; semanticQa: "needs-human-review" };
  roster: Roster; words: Word[]; shots: BreakdownShot[]; review: string[];
};
export type BreakdownOptions = { source: string; to: string; threshold?: number; maxShots?: number; model?: string; analysisProvider?: "kie" | "fal"; allowPaid?: boolean;
  kieKey?: string; falKey?: string; log?: (message: string) => void };

export async function detectCuts(source: string, threshold: number): Promise<number[]> {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error("Cut threshold must be between 0 and 1");
  // Keep every decoded source frame; scene candidates retain the source's own clock.
  const { stderr } = await execute("ffmpeg", ["-hide_banner", "-nostdin", "-i", source, "-an", "-vf", `select='gt(scene,${threshold})',showinfo`, "-fps_mode", "vfr", "-f", "null", "-"], { timeout: 300_000, maxBuffer: 8_000_000 });
  return [...stderr.matchAll(/\bpts_time:([\d.]+)/gu)].map(m => Number(m[1]));
}
export async function breakdown(options: BreakdownOptions): Promise<Breakdown> {
  const source = resolve(options.source), root = resolve(options.to), log = options.log ?? (() => {});
  const analysisProvider = options.analysisProvider ?? "kie";
  const model = options.model ?? (analysisProvider === "kie" ? "gemini-3-6-flash-openai" : "fal-ai/video-understanding"), threshold = options.threshold ?? 0.08, maxShots = options.maxShots ?? 100;
  if (!Number.isSafeInteger(maxShots) || maxShots < 1 || maxShots > 500) throw new Error("maxShots must be an integer from 1 to 500");
  if (options.allowPaid !== true) throw new Error("Use --allow-paid to authorize this analysis through KIE and fal");
  const kieKey = options.kieKey ?? process.env.KIE_API_KEY ?? "", falKey = options.falKey ?? process.env.FAL_KEY ?? "";
  const kie = analysisProvider === "kie" ? new CloudClient("kie", kieKey) : undefined, fal = new CloudClient("fal", falKey);
  const bytes = await readFile(source), sha256 = digest(bytes);
  const info = await probeMedia(source);
  if (!info.hasVideo || info.duration > 600) throw new Error("Provide a video up to 600 seconds; split longer sources first");
  const videoProbe = await execute("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "json", source]);
  const measuredVideo = Number(JSON.parse(videoProbe.stdout).streams?.[0]?.duration);
  const videoDuration = Number.isFinite(measuredVideo) && measuredVideo > 0 ? Math.min(measuredVideo, info.duration) : info.duration;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".run.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  try {
    const identity = { sha256, threshold, model, version: 1, account: digest((analysisProvider === "kie" ? digest(kieKey) : "") + digest(falKey)) };
    const previous = await readJson(join(root, ".identity.json"));
    if (previous && JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error("Source, settings or accounts changed; use a new output directory");
    await saveJson(join(root, ".identity.json"), identity);
    const receipt = new Ledger(root, identity.account, log);
    const mediaIdentity = new Map<string, string>();
    const analyze = async (name: string, prompt: string, urls: readonly string[]): Promise<unknown> => {
      const media = urls.map(url => mediaIdentity.get(url) ?? url);
      if (analysisProvider === "kie") return analysisJson(await receipt.analysis(name, kie!, prompt, urls, model, media));
      // The fal endpoint consumes continuous video, not a list of still-image attachments.
      if (prompt.length > 5000) throw new Error("fal video-understanding prompt exceeds 5000 characters; reduce roster or use KIE in a new analysis directory");
      const response = await receipt.remote(`${name}-v2`, fal, model, { video_url: urls[0], prompt, detailed_analysis: true }, { inputIdentity: digest(JSON.stringify({ media: media[0], prompt, detailed_analysis: true })) });
      return analysisJson(response);
    };
    const local = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const path = join(root, `${name}.json`), saved = await readJson(path);
      if (saved !== undefined) return saved as T;
      const result = await work(); await saveJson(path, result); return result;
    };
    const exists = (path: string) => stat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    // Upload cache is scoped to the source, account and settings directory. Media stays local.
    const upload = async (path: string, mediaType: string): Promise<string> => {
      const data = await readFile(path), id = digest(data), cache = join(root, ".uploads", `${id}.json`);
      const saved = await readJson(cache);
      if (saved && saved.expiresAt > Date.now() + 60_000) {
        const response = await fetch(publicUrl(saved.url), { method: "HEAD", signal: AbortSignal.timeout(15_000) });
        await response.body?.cancel();
        if (response.ok) { mediaIdentity.set(saved.url, id); return saved.url; }
        if (![401, 403, 404, 410].includes(response.status)) throw new Error(`Upload availability check failed (${response.status})`);
      }
      const url = await fal.upload(data, mediaType);
      await mkdir(join(root, ".uploads"), { recursive: true, mode: 0o700 });
      await saveJson(cache, { url, expiresAt: Date.now() + 12 * 3_600_000 });
      mediaIdentity.set(url, id);
      return url;
    };
    const copiedSource = join(root, "source.mp4");
    if (!await exists(copiedSource)) await copyFile(source, copiedSource);
    if (digest(await readFile(copiedSource)) !== sha256) throw new Error("Saved source bytes changed");
    log("Detecting cuts from decoded source frames");
    const cuts = await local("cuts", () => detectCuts(source, threshold));
    const shots = intervals(info.duration, consolidateCuts(cuts, info.duration));
    if (shots.length > maxShots) throw new Error(`Detected ${shots.length} candidate shots, above --max-shots ${maxShots}; review cuts before spending`);
    log(`${shots.length} candidate shots; duration ${info.duration}s`);
    let words: Word[] = [];
    if (info.hasAudio) {
      const audio = join(root, "source.mp3");
      if (!await exists(audio)) await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source, "-vn", "-c:a", "libmp3lame", "-b:a", "128k", audio], { timeout: 300_000 });
      const transcript = await local("transcript", async () => {
        const audioUrl = await upload(audio, "audio/mpeg");
        return await receipt.remote("transcript", fal, "fal-ai/elevenlabs/speech-to-text/scribe-v2", { audio_url: audioUrl, diarize: true }, { inputIdentity: digest(JSON.stringify({ audio: mediaIdentity.get(audioUrl), diarize: true })) });
      });
      words = parseWords(transcript, info.duration);
    }
    log(`${words.length} timed ASR words`);
    const roster = await local("roster", async () => {
      const url = await upload(source, "video/mp4");
      return parseRoster(await analyze("overview", overviewPrompt(info.duration, words), [url]));
    });
    // Validate cached normalized output too; edits must not hide broken referential integrity.
    parseRoster(roster);
    const links = speechLinks(shots, words), resultShots: BreakdownShot[] = [];
    for (const [i, shot] of shots.entries()) {
      const directory = join(root, "evidence", shot.id);
      await mkdir(directory, { recursive: true });
      const clip = join(directory, "clip.mp4");
      if (!await exists(clip)) await cutClip(source, shot.start, shot.end, clip);
      const times = sampleTimes(shot, info.frameRate, videoDuration);
      const frames = await local(`${shot.id}-frames`, async () => {
        const frames = [];
        for (const [j, time] of times.entries()) {
          const path = join(directory, `frame-${j + 1}.jpg`), at = await cutFrame(source, time, path);
          if (at >= shot.end + 0.001) throw new Error(`${shot.id} sample escaped its source interval`);
          frames.push({ path: `evidence/${shot.id}/frame-${j + 1}.jpg`, at });
        }
        return frames;
      });
      const localWords = links[i]!.map(index => words[index]!);
      const analyzed = await local(`${shot.id}-analysis`, async () => {
        const urls = [await upload(clip, "video/mp4")];
        if (analysisProvider === "kie") for (const frame of frames) urls.push(await upload(join(root, frame.path), "image/jpeg"));
        const prompt = shotPrompt(shot, roster, localWords).replace("第一个附件是此镜头的连续视频，后面三图是首中尾采样帧。", analysisProvider === "kie" ? "第一个附件是此镜头的连续视频，后面三图是首中尾采样帧。" : "附件是此镜头的连续视频；请检查视频的首中尾和完整动作。");
        return parseShot(await analyze(shot.id, prompt, urls), shot.id, roster);
      });
      parseShot(analyzed, shot.id, roster);
      const review = [...analyzed.uncertainties];
      if (cuts.some(t => t > shot.start + 0.001 && t < shot.end)) review.push("镜内包含已聚合的相邻切点候选，复核快速切镜或转场");
      if (/切换|切到|镜头切|画面转/u.test(analyzed.visibleAction)) review.push("模型描述镜内存在画面切换，可能漏检渐变或切镜，需要拆分复核");
      if (shot.end - shot.start < 0.4) review.push("镜头短于0.4秒，复核闪光、转场或误切");
      if (shot.end - shot.start > 12) review.push("长镜头，复核漏切、内部动作与运镜");
      if (localWords.some(w => w.start < shot.start || w.end > shot.end)) review.push("台词跨越摄影切点，保留独立音频时间线");
      resultShots.push({ ...shot, analysis: analyzed, clip: `evidence/${shot.id}/clip.mp4`, frames, wordIndices: links[i]!, review });
      await saveJson(join(root, "progress.json"), { completed: resultShots.length, total: shots.length, generationSubmitted: false });
      log(`Analyzed ${shot.id} (${resultShots.length}/${shots.length}): ${analyzed.location}`);
    }
    const covered = new Set(links.flat());
    if (words.some((_w, index) => !covered.has(index))) throw new Error("Unlinked ASR words require timestamp review");
    const review = ["切点是机械候选，未经逐帧人工验收；淡入淡出、闪光和快速运动需复核", "人物声音组与视觉角色尚未人工映射，不自动断言谁在说话", "语义分析为模型原始结果，尚未通过独立QA"];
    const result: Breakdown = {
      format: "hypit.breakdown@1", source: { file: "source.mp4", sha256, duration: info.duration, videoDuration, width: info.width, height: info.height, frameRate: info.frameRate },
      provenance: { method: `ffmpeg scene candidates + fal Scribe v2 + ${analysisProvider} whole-video roster + isolated-shot video${analysisProvider === "kie" ? " and 3 frames" : "; 3 source frames retained for human review"}`, model, createdAt: new Date().toISOString(), generationSubmitted: false, semanticQa: "needs-human-review" },
      roster, words, shots: resultShots, review,
    };
    await saveJson(join(root, "breakdown.json"), result);
    const contact = join(root, "contact-sheet.jpg");
    if (!await exists(contact)) await tileFrames(source, shots.map(s => (s.start + s.end) / 2), contact, 240, 5);
    await exportReports(root, result);
    log("Complete: breakdown.json, ANALYSIS.md, TIMELINE.md, report.html, contact-sheet.jpg");
    return result;
  } finally { await unlink(lock); }
}
