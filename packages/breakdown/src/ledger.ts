import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CloudClient, CloudError } from "@hypit/provider-kie-fal/client";
import type { TaskHandle } from "@hypit/provider-kie-fal/client";

export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export async function saveJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export async function readJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
type Step = { fingerprint: string; state: "submitting" | "accepted" | "complete"; task?: TaskHandle; response?: Record<string, unknown> };

/** Caller holds one exclusive directory lock. Every paid intent is saved before its POST. */
export class Ledger {
  constructor(readonly root: string, readonly accountIdentity: string, readonly log: (message: string) => void = () => {}) {}
  private async path(name: string) {
    if (!/^[a-z0-9-]+$/u.test(name)) throw new Error("Invalid step name");
    await mkdir(join(this.root, ".receipts"), { recursive: true, mode: 0o700 });
    return join(this.root, ".receipts", `${name}.json`);
  }
  async remote(name: string, api: CloudClient, model: string, input: Record<string, unknown>, options: { timeoutMs?: number; inputIdentity?: string } = {}): Promise<Record<string, unknown>> {
    const path = await this.path(name), fingerprint = digest(JSON.stringify({ account: this.accountIdentity, service: api.service, model, input: options.inputIdentity ?? input }));
    let step = await readJson(path) as Step | undefined;
    if (step && step.fingerprint !== fingerprint) throw new Error(`Step ${name} input changed; use a new output directory`);
    if (step?.state === "complete") { this.log(`Reusing ${name}`); return step.response!; }
    if (step?.state === "submitting") throw new Error(`Step ${name} has an unknown submission; reconcile its provider receipt before retrying`);
    if (!step) {
      step = { fingerprint, state: "submitting" };
      await saveJson(path, step);
      this.log(`Submitting ${name}`);
      const task = await api.submit(model, input);
      step = { fingerprint, state: "accepted", task };
      await saveJson(path, step);
    }
    const deadline = Date.now() + (options.timeoutMs ?? 900_000);
    while (Date.now() < deadline) {
      try {
        const result = await api.poll(step.task!);
        if (result.status === "complete") {
          await saveJson(path, { ...step, state: "complete", response: result.response });
          return result.response;
        }
      } catch (error) {
        if (!(error instanceof CloudError) || !(error.code === "TRANSPORT" || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    throw new Error(`Step ${name} timed out; resume to query existing task ${step.task!.id}`);
  }
  async analysis(name: string, api: CloudClient, prompt: string, urls: readonly string[], model: string, mediaIdentity?: readonly string[]): Promise<Record<string, unknown>> {
    const path = await this.path(name), fingerprint = digest(JSON.stringify({ account: this.accountIdentity, model, prompt, urls: mediaIdentity ?? urls }));
    const step = await readJson(path) as Step | undefined;
    if (step && step.fingerprint !== fingerprint) throw new Error(`Step ${name} input changed; use a new output directory`);
    if (step?.state === "complete") { this.log(`Reusing ${name}`); return step.response!; }
    if (step) throw new Error(`Step ${name} has an unknown synchronous submission; reconcile before retrying`);
    await saveJson(path, { fingerprint, state: "submitting" });
    this.log(`Analyzing ${name}`);
    const response = await api.analyze(prompt, urls, model);
    await saveJson(path, { fingerprint, state: "complete", response });
    return response;
  }
}
