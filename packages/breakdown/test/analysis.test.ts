import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudClient } from "@hypit/provider-kie-fal/client";
import { consolidateCuts, intervals, sampleTimes, speechLinks, parseWords, parseShot, parseRoster, overviewPrompt, compactSpeech } from "../src/analysis.js";
import { Ledger } from "../src/ledger.js";
import { escapeHtml } from "../src/report.js";

test("source intervals preserve full duration, sort cuts and have no overlap", () => {
  const shots = intervals(10, [7, 3, 3, 0, 10]);
  assert.deepEqual(shots.map(s => [s.start, s.end]), [[0, 3], [3, 7], [7, 10]]);
  assert.throws(() => intervals(10, [NaN])); assert.throws(() => intervals(10, [11]));
});
test("adjacent cut candidates are grouped without treating them as confirmed flashes", () => {
  assert.deepEqual(consolidateCuts([2, 2.033, 5, 5.2, 5.4, 7], 10), [2, 5, 7]);
});
test("sample times stay inside each interval", () => {
  for (const shot of intervals(1, [0.2, 0.6])) assert.ok(sampleTimes(shot, 30).every(t => t > shot.start && t < shot.end));
});
test("last sample uses the video end when the container has a longer audio tail", () => {
  const times = sampleTimes({ id: "last", start: 71, end: 78.553 }, 30, 78.533333);
  assert.ok(times[2]! < 78.5); assert.ok(times.every(t => t >= 71));
});
test("one word crossing a cut stays one word and links to both shots", () => {
  const words = [{ text: "yes", start: 0.8, end: 1.2, speaker: null }];
  assert.deepEqual(speechLinks(intervals(2, [1]), words), [[0], [0]]); assert.equal(words.length, 1);
});
test("ASR retains independent speaker IDs and rejects out-of-range words", () => {
  assert.deepEqual(parseWords({ words: [{ type: "word", text: "Hi", start: 0, end: 0.3, speaker_id: "speaker_0" }, { type: "spacing", text: " " }] }, 2), [{ text: "Hi", start: 0, end: 0.3, speaker: "speaker_0" }]);
  assert.throws(() => parseWords({ words: [{ type: "word", text: "Hi", start: 0, end: 3 }] }, 2));
});
test("wrong shot IDs and unknown visual characters never enter the report", () => {
  const roster = { summary: "scene", characters: [{ id: "C01", appearance: "hat" }], storyBeats: [], uncertainties: [] };
  assert.throws(() => parseShot({ id: "wrong" }, "shot-001", roster));
  assert.throws(() => parseShot({ id: "shot-001", characters: ["invented"] }, "shot-001", roster));
});
test("report HTML escapes source strings", () => { assert.equal(escapeHtml('<script>"&\''), "&lt;script&gt;&quot;&amp;&#39;"); });
test("timed story objects normalize without changing the original event text", () => {
  const roster = parseRoster({ summary: "story", characters: [], storyBeats: [{ time: "1–2", event: "turn" }], uncertainties: [] });
  assert.deepEqual(roster.storyBeats, ["1–2 · turn"]);
});
test("long ASR context remains below fal's limit while original words stay intact", () => {
  const words = Array.from({ length: 2000 }, (_v, i) => ({ text: "dialogue", start: i * 0.1, end: i * 0.1 + 0.1, speaker: "speaker_0" }));
  assert.ok(overviewPrompt(200, words).length < 5000); assert.equal(words.length, 2000);
  assert.ok(compactSpeech(words).includes("dialogue"));
});
test("resume reuses completed paid responses and refuses changed inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-ledger-")); let submissions = 0, polls = 0;
  const api = new CloudClient("kie", "fixture", async (_input, init) => {
    if (init?.method === "POST") { submissions++; return Response.json({ code: 200, data: { taskId: "job" } }); }
    polls++; return Response.json({ code: 200, data: { taskId: "job", model: "model", state: "success", resultJson: '{"resultUrls":["https://media.test/result"]}' } });
  });
  const ledger = new Ledger(root, "account");
  await ledger.remote("step", api, "model", { prompt: "one" }); await ledger.remote("step", api, "model", { prompt: "one" });
  assert.equal(submissions, 1); assert.equal(polls, 1);
  await assert.rejects(ledger.remote("step", api, "model", { prompt: "different" }), /input changed/u);
  assert.ok(!(await readFile(join(root, ".receipts", "step.json"), "utf8")).includes("fixture"));
});
test("unknown synchronous analysis remains blocked across process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-ledger-")); let calls = 0;
  const api = new CloudClient("kie", "fixture", async () => { calls++; throw new Error("lost response"); });
  await assert.rejects(new Ledger(root, "account").analysis("shot", api, "look", [], "gemini-3-6-flash-openai"));
  await assert.rejects(new Ledger(root, "account").analysis("shot", api, "look", [], "gemini-3-6-flash-openai"), /unknown synchronous submission/u);
  assert.equal(calls, 1);
});
test("rotated temporary URLs still reconcile the same accepted task when content identity is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-ledger-")); let submissions = 0, failed = false;
  const api = new CloudClient("kie", "fixture", async (_url, init) => {
    if (init?.method === "POST") { submissions++; return Response.json({ code: 200, data: { taskId: "job" } }); }
    if (!failed) { failed = true; return Response.json({ code: 200, data: { taskId: "mismatched", model: "model", state: "waiting" } }); }
    return Response.json({ code: 200, data: { taskId: "job", model: "model", state: "success", resultJson: '{}' } });
  });
  const options = { inputIdentity: "same-source-content-and-options" };
  await assert.rejects(new Ledger(root, "account").remote("step", api, "model", { video_url: "https://media.test/expired" }, options));
  await new Ledger(root, "account").remote("step", api, "model", { video_url: "https://media.test/refreshed" }, options);
  assert.equal(submissions, 1);
});
