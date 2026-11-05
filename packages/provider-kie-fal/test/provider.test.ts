import assert from "node:assert/strict";
import test from "node:test";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/executor";
import { credentialRef } from "@hypit/hypit/endpoint";
import type { CanonicalValue, Need } from "@hypit/hypit/protocol";
import { generationTypes, assertMappingCoversPorts } from "@hypit/generation";
import { nanoBananaPorts, sealNanoBananaRequest } from "@hypit/nano-banana";
import { grokImaginePorts, sealGrokImagineRequest } from "@hypit/grok-imagine";
import { seedancePorts, sealSeedanceRequest } from "@hypit/seedance";
import { CloudClient, CloudError } from "../src/client.js";
import { mappings, compile, support } from "../src/routes.js";
import { createKieFalProvider } from "../src/provider.js";
import { openLocalRuntimeHost } from "@hypit/runtime-local";
import { fileURLToPath } from "node:url";

const imageRequest = () => sealNanoBananaRequest("nano-banana-2", { prompt: ["A neutral room"], aspectRatio: ["9:16"], resolution: ["1K"], outputFormat: ["png"] });
const needFor = (request: unknown): Need => ({ id: "need:cloud", result: "record:cloud", capability: mappings.kie[0]!.capability,
  returns: generationTypes.imageSet, constraints: request as CanonicalValue });
const credential = "fixture-secret-do-not-log";
const json = (value: unknown, status = 200) => Response.json(value, { status });

test("every route covers the exact model port table", () => {
  const tables = { ...nanoBananaPorts, ...grokImaginePorts, ...seedancePorts };
  for (const mapping of [...mappings.kie, ...mappings.fal]) assertMappingCoversPorts(tables[mapping.capability.name as keyof typeof tables], mapping);
});
test("Nano Banana jpg maps to fal jpeg and text/edit paths remain distinct", async () => {
  const request = sealNanoBananaRequest("nano-banana-2", { ...imageRequest().ports, outputFormat: ["jpg"] });
  const result = await compile("fal", mappings.fal[0]!, request, async () => "https://media.test/image");
  assert.equal(result.model, "fal-ai/nano-banana-2"); assert.equal(result.input.output_format, "jpeg");
  const edit = sealNanoBananaRequest("nano-banana-2", { ...request.ports, images: [{ role: "image", artifact: { kind: "blob", resource: "res_ref", mediaType: "image/png", size: 3 } }] });
  assert.equal((await compile("fal", mappings.fal[0]!, edit, async () => "https://media.test/image")).model, "fal-ai/nano-banana-2/edit");
  assert.deepEqual((await compile("kie", mappings.kie[0]!, edit, async () => "https://media.test/image")).input.image_input, ["https://media.test/image"]);
});
test("KIE enforces the current 10-reference limit during planning", () => {
  const images = Array.from({ length: 11 }, () => ({ role: "image" as const, artifact: { kind: "blob" as const, resource: "res_ref" as const, mediaType: "image/png", size: 3 } }));
  const request = sealNanoBananaRequest("nano-banana-2", { ...imageRequest().ports, images });
  assert.equal(support("kie", mappings.kie[0]!, needFor(request)).status, "unsupported");
});
test("KIE Seedance sends exact model and refuses web search", async () => {
  const request = sealSeedanceRequest("seedance-2-mini", { prompt: ["Walk"], resolution: ["720p"], aspectRatio: ["9:16"], duration: [5], generateAudio: [true], webSearch: [false] });
  const wire = await compile("kie", mappings.kie[1]!, request, async () => "https://media.test/ref");
  assert.equal(wire.model, "bytedance/seedance-2-mini"); assert.equal(wire.input.web_search, undefined); assert.equal(wire.input.generate_audio, true);
  const changed = sealSeedanceRequest("seedance-2-mini", { ...request.ports, webSearch: [true] });
  assert.equal(support("kie", mappings.kie[1]!, { ...needFor(changed), capability: mappings.kie[1]!.capability }).status, "unsupported");
});
test("fal Grok rejects unsupported resolution and multiple future images before upload", () => {
  const request = sealGrokImagineRequest("grok-imagine-video", { prompt: ["Walk"], aspectRatio: ["9:16"], resolution: ["1080p"], duration: [6] });
  assert.equal(support("fal", mappings.fal[1]!, needFor(request)).status, "unsupported");
  const low = sealGrokImagineRequest("grok-imagine-video", { ...request.ports, resolution: ["720p"] });
  assert.equal(support("fal", mappings.fal[1]!, { ...needFor(low), pendingInputs: [{ input: "images" }, { input: "images" }] }).status, "unsupported");
});
test("KIE HTTP 200 with application error is a failure", async () => {
  const api = new CloudClient("kie", credential, async () => json({ code: 402, msg: "secret and signed URL must not leak" }));
  await assert.rejects(api.submit("nano-banana-2", {}), error => error instanceof CloudError && error.code === "KIE_402" && !error.message.includes("signed"));
});
test("lost POST acknowledgements never trigger a retry", async () => {
  let requests = 0;
  const api = new CloudClient("fal", credential, async () => { requests++; throw new Error(credential); });
  await assert.rejects(api.submit("fal-ai/nano-banana-2", {}), error => error instanceof CloudError && error.code === "SUBMISSION_UNKNOWN" && !error.message.includes(credential));
  assert.equal(requests, 1);
});
test("non-JSON POST response is an unknown submission", async () => {
  const api = new CloudClient("fal", credential, async () => new Response("broken", { status: 200 }));
  await assert.rejects(api.submit("fal-ai/nano-banana-2", {}), /unreadable JSON/u);
});
test("fal queue URLs cannot receive credentials on another host", async () => {
  const api = new CloudClient("fal", credential, async () => json({ request_id: "id", status_url: "https://untrusted.test/status", response_url: "https://queue.fal.run/result" }));
  await assert.rejects(api.submit("fal-ai/nano-banana-2", {}), /valid task receipt/u);
});
test("KIE task identity mismatch and confirmed failure stop execution", async () => {
  const handle = { service: "kie" as const, model: "nano-banana-2", id: "id", startedAt: Date.now() };
  for (const data of [{ taskId: "other", model: handle.model, state: "success" }, { taskId: "id", model: handle.model, state: "fail" }]) {
    const api = new CloudClient("kie", credential, async () => json({ code: 200, data }));
    await assert.rejects(api.poll(handle));
  }
});
test("native endpoint checkpoints a receipt and collects media without authorization", async () => {
  const paths: string[] = [], checkpoints: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); paths.push(url);
    if (url === "https://media.test/image.png") {
      assert.equal(init?.headers, undefined);
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${credential}`);
    if (url.endsWith("createTask")) return json({ code: 200, data: { taskId: "job" } });
    return json({ code: 200, data: { taskId: "job", model: "nano-banana-2", state: "success", resultJson: JSON.stringify({ resultUrls: ["https://media.test/image.png"] }) } });
  };
  const provider = createKieFalProvider({ service: "kie", apiKey: credentialRef("env", "KIE_API_KEY"), fetch: fetcher });
  const registry = new EndpointRegistry(); await provider.install(registry);
  const need = needFor(imageRequest()), selected = registry.resolve(need);
  assert.equal(selected.status, "resolved");
  if (selected.status !== "resolved" || selected.registration.kind !== "asynchronous") throw new Error("Endpoint not resolved");
  const endpoint = selected.registration.endpoint, resources = new MemoryResourceStore();
  const context = { command: { kind: "fulfill-need" as const, id: "command:cloud", need }, need, resources, credentials: { apiKey: { secret: credential } }, operation: "op", checkpoint: async (v: unknown) => { checkpoints.push(v); } };
  const submitted = await endpoint.start(context); assert.equal(submitted.status, "pending"); assert.equal(checkpoints.length, 1);
  if (submitted.status !== "pending") throw new Error("No task");
  const ready = await endpoint.poll({ ...context, handle: submitted.handle }); assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("No output");
  const result = await endpoint.collect!({ ...context, handle: ready.handle }); assert.equal(result.status, "completed");
  assert.equal(paths.length, 3);
});
test("the shipped Runtime loads real activation packages and resolves three bound capabilities without API access", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const host = await openLocalRuntimeHost(fileURLToPath(new URL("../../../examples/kie-fal.runtime.json", import.meta.url)), {
    packageRoot: root, distributionPackageRoot: root, workerLaunch: { command: process.execPath, args: [] },
  });
  const mini = sealSeedanceRequest("seedance-2-mini", { prompt: ["Walk"], resolution: ["720p"], aspectRatio: ["9:16"], duration: [5], generateAudio: [true], webSearch: [false] });
  const video = sealGrokImagineRequest("grok-imagine-video", { prompt: ["Walk"], aspectRatio: ["9:16"], resolution: ["720p"], duration: [6] });
  const requests = [[mappings.fal[0]!, imageRequest()], [mappings.kie[1]!, mini], [mappings.fal[1]!, video]] as const;
  const providers = await host.providers(requests.map(([mapping, request], i) => ({ request: `request-${i}`, capability: mapping.capability,
    returns: mapping.result === "image" ? generationTypes.imageSet : generationTypes.videoSet, constraints: request as unknown as CanonicalValue })));
  assert.deepEqual(providers.map(p => [p.status, "endpoint" in p ? p.endpoint : null]), [["resolved", "fal"], ["resolved", "kie"], ["resolved", "fal"]]);
});
