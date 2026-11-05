import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutClip, cutFrame, probeMedia } from "@hypit/media-local/files";
import { detectCuts, breakdown } from "../src/index.js";
import { intervals, sampleTimes } from "../src/analysis.js";

test("decoded source cuts, clip duration and sample timestamps agree on a real synthetic video", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-cut-evidence-")), source = join(root, "source.mp4");
  await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=96x160:d=1:r=30", "-f", "lavfi", "-i", "color=c=white:s=96x160:d=1:r=30", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[out]", "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", source]);
  const info = await probeMedia(source); assert.ok(Math.abs(info.duration - 2) < 0.04);
  const cuts = await detectCuts(source, 0.08); assert.equal(cuts.length, 1); assert.ok(Math.abs(cuts[0]! - 1) < 0.04);
  const shots = intervals(info.duration, cuts), second = shots[1]!;
  const clip = join(root, "clip.mp4"); await cutClip(source, second.start, second.end, clip);
  assert.ok(Math.abs((await probeMedia(clip)).duration - 1) < 0.04);
  for (const [i, time] of sampleTimes(second, 30).entries()) {
    const frame = join(root, `${i}.jpg`), actual = await cutFrame(source, time, frame);
    assert.ok(actual >= second.start && actual < second.end); assert.ok((await stat(frame)).size > 0);
  }
});
test("analysis requires explicit paid authorization before opening a source or contacting services", async () => {
  await assert.rejects(breakdown({ source: "missing-source.mp4", to: "unused" }), /allow-paid/u);
});
