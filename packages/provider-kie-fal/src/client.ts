import { createFalClient } from "@fal-ai/client";

export type Service = "kie" | "fal";
export type TaskHandle = { service: Service; model: string; id: string; startedAt: number; statusUrl?: string; resultUrl?: string };
export type TaskState = { status: "pending" } | { status: "complete"; response: Record<string, unknown> };
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected API object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty API text");
  return value;
}
export function publicUrl(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Expected public HTTPS media URL");
  return url.href;
}
function queueUrl(value: unknown): string {
  const url = new URL(publicUrl(value));
  if (url.origin !== "https://queue.fal.run") throw new Error("Unexpected fal queue origin");
  return url.href;
}
export class CloudError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number) { super(message); }
}

/** No POST retries. A lost acknowledgement requires reconciliation, never blind resubmission. */
export class CloudClient {
  constructor(readonly service: Service, private readonly key: string, private readonly fetcher: typeof fetch = fetch) {
    if (!key.trim()) throw new Error(`${service} API credential is missing`);
  }
  private async json(url: string, init: RequestInit = {}, timeout = 120_000): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeout),
        headers: { authorization: `${this.service === "fal" ? "Key" : "Bearer"} ${this.key}`, ...init.headers } });
    } catch { throw new CloudError(init.method === "POST" ? "SUBMISSION_UNKNOWN" : "TRANSPORT", `${this.service} request transport failed`); }
    // Read/parse failures after a successful POST can also leave paid work running.
    let body: Record<string, unknown>;
    try { body = object(await response.json()); }
    catch { throw new CloudError(init.method === "POST" ? "SUBMISSION_UNKNOWN" : "INVALID_RESPONSE", `${this.service} returned unreadable JSON`, response.status); }
    if (!response.ok) {
      const raw = body.detail ?? body.error ?? body.message ?? "";
      const detail = JSON.stringify(Array.isArray(raw) ? raw.map(v => { const r = object(v); return { type: r.type, loc: r.loc, msg: r.msg }; }) : raw).replaceAll(this.key, "[credential]").replace(/https?:\/\/[^\s"\\]+/gu, "[URL]").slice(0, 1_500);
      throw new CloudError(`HTTP_${response.status}`, `${this.service} API returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    if (this.service === "kie" && body.code !== undefined && body.code !== 200) {
      // Do not serialize vendor errors: they can echo signed URLs or private prompts.
      throw new CloudError(`KIE_${String(body.code)}`, `KIE rejected the request (code ${String(body.code)})`);
    }
    return body;
  }
  async upload(bytes: Uint8Array, mediaType: string): Promise<string> {
    const ext = ({ "video/mp4": "mp4", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/mpeg": "mp3", "audio/wav": "wav" } as Record<string, string>)[mediaType] ?? "bin";
    if (this.service === "fal") {
      const sdk = createFalClient({ credentials: this.key, retry: { maxRetries: 0 }, fetch: this.fetcher });
      try { return publicUrl(await sdk.storage.upload(new File([new Uint8Array(bytes)], `reference.${ext}`, { type: mediaType }), { lifecycle: { expiresIn: "1d" } })); }
      catch { throw new CloudError("UPLOAD_FAILED", "fal reference upload failed"); }
    }
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], `reference.${ext}`, { type: mediaType }));
    form.set("uploadPath", "hypit");
    const response = await this.json("https://kieai.redpandaai.co/api/file-stream-upload", { method: "POST", body: form });
    if (response.success !== true) throw new CloudError("UPLOAD_FAILED", "KIE upload was not acknowledged");
    return publicUrl(object(response.data).downloadUrl);
  }
  async submit(model: string, input: Record<string, unknown>): Promise<TaskHandle> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(model) || model.includes("..")) throw new Error("Invalid model identifier");
    const body = await this.json(this.service === "fal" ? `https://queue.fal.run/${model}` : "https://api.kie.ai/api/v1/jobs/createTask", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.service === "fal" ? input : { model, input }),
    });
    try {
      return this.service === "fal"
        ? { service: "fal", model, id: text(body.request_id), startedAt: Date.now(), statusUrl: queueUrl(body.status_url), resultUrl: queueUrl(body.response_url) }
        : { service: "kie", model, id: text(object(body.data).taskId), startedAt: Date.now() };
    } catch { throw new CloudError("SUBMISSION_UNKNOWN", `${this.service} submission did not include a valid task receipt`); }
  }
  async poll(handle: TaskHandle): Promise<TaskState> {
    if (handle.service !== this.service) throw new Error("Task belongs to another service");
    if (this.service === "fal") {
      const status = await this.json(queueUrl(handle.statusUrl));
      if (["IN_QUEUE", "IN_PROGRESS"].includes(String(status.status))) return { status: "pending" };
      if (status.status !== "COMPLETED") throw new CloudError("INVALID_STATE", "fal returned an unknown queue state");
      return { status: "complete", response: await this.json(queueUrl(handle.resultUrl)) };
    }
    const data = object((await this.json(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(handle.id)}`)).data);
    if (data.taskId !== handle.id || data.model !== handle.model) throw new CloudError("INVALID_RECEIPT", "KIE task receipt does not match");
    if (data.state === "fail") throw new CloudError("TASK_FAILED", `KIE task ${handle.id} failed`);
    if (["waiting", "queuing", "generating"].includes(String(data.state))) return { status: "pending" };
    if (data.state !== "success") throw new CloudError("INVALID_STATE", "KIE returned an unknown task state");
    return { status: "complete", response: object(JSON.parse(text(data.resultJson))) };
  }
  async analyze(prompt: string, mediaUrls: readonly string[], model = "gemini-3-6-flash-openai"): Promise<Record<string, unknown>> {
    if (this.service !== "kie" || !/^gemini-[a-z0-9-]+-openai$/u.test(model)) throw new Error("Expected KIE Gemini OpenAI endpoint");
    return this.json(`https://api.kie.ai/${model}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: false,
        reasoning_effort: "low", include_thoughts: false,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...mediaUrls.map(url => ({ type: "image_url", image_url: { url: publicUrl(url) } }))] }],
      }),
    }, 600_000);
  }
}

export function analysisJson(response: Record<string, unknown>): unknown {
  if (typeof response.output === "string") return JSON.parse(response.output.replace(/^```(?:json)?\s*|\s*```$/gu, ""));
  const choices = response.choices;
  if (!Array.isArray(choices)) throw new Error("Gemini returned no choices");
  const content = text(object(object(choices[0]).message).content);
  return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/gu, ""));
}
