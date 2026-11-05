import { canonicalize, defineEndpoint, wakeAfter } from "@hypit/hypit/endpoint";
import type { AsyncEndpoint, CredentialRef } from "@hypit/hypit/endpoint";
import { generationTypes, sealGeneratedImageSet, sealGeneratedVideoSet } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";
import { CloudClient, CloudError, object, publicUrl, text } from "./client.js";
import type { Service, TaskHandle } from "./client.js";
import { compile, mappings, support } from "./routes.js";

export function createKieFalProvider(options: {
  service: Service; instance?: string; pool?: string; apiKey: CredentialRef;
  defaultConcurrency?: number; pollIntervalMs?: number; operationTimeoutMs?: number; fetch?: typeof fetch;
}) {
  const service = options.service, interval = options.pollIntervalMs ?? 2_000;
  const fetcher = options.fetch ?? fetch;
  const client = (credentials: Readonly<Record<string, { secret: string }>>) => new CloudClient(service, text(credentials.apiKey?.secret), fetcher);
  const handle = (value: unknown): TaskHandle => {
    const h = object(value);
    if (h.service !== service || typeof h.startedAt !== "number" || !Number.isFinite(h.startedAt)) throw new Error("Invalid task handle");
    text(h.id); text(h.model);
    return h as unknown as TaskHandle;
  };
  return defineEndpoint({
    instance: options.instance ?? service, pool: options.pool ?? service,
    credentials: { apiKey: options.apiKey }, credentialInputs: { apiKey: { label: `${service} API key` } },
    defaultConcurrency: options.defaultConcurrency ?? 1,
    actionLimits: { submit: { concurrency: 1 }, poll: { concurrency: 4 }, collect: { concurrency: 2 } },
    pricing: { kind: "page", url: service === "fal" ? "https://fal.ai/pricing" : "https://kie.ai/pricing" },
    capabilities: mappings[service].map(mapping => {
      const endpoint: AsyncEndpoint = {
        async start(context) {
          const supported = support(service, mapping, context.need);
          if (supported.status === "unsupported") throw new Error(supported.reason);
          const api = client(context.credentials);
          const uploaded = new Map<string, Promise<string>>();
          const prepared = await compile(service, mapping, context.need.constraints as unknown as GenerationRequest, artifact => {
            let url = uploaded.get(artifact.resource);
            if (!url) {
              url = (async () => {
                const bytes = await context.resources.get(artifact.resource);
                if (!bytes || bytes.length !== artifact.size) throw new Error("Reference resource unavailable or changed");
                const limit = mapping.result === "image" ? 30_000_000 : 10_000_000;
                if (bytes.length > limit) throw new Error("Reference exceeds provider upload limit");
                return api.upload(bytes, artifact.mediaType);
              })();
              uploaded.set(artifact.resource, url);
            }
            return url;
          });
          try {
            const task = await api.submit(prepared.model, prepared.input);
            await context.checkpoint?.({ handle: canonicalize(task), receipt: { id: task.id } });
            return { ...wakeAfter(canonicalize(task), interval), receipt: { id: task.id } };
          } catch (error) {
            if (!(error instanceof CloudError)) throw error;
            return { status: "failed", failure: { code: error.code, message: error.message } };
          }
        },
        async poll(context) {
          const task = handle(context.handle);
          if (Date.now() - task.startedAt > (options.operationTimeoutMs ?? 1_800_000)) return {
            status: "failed", receipt: { id: task.id }, failure: { code: "OPERATION_TIMEOUT", message: `Reconcile existing ${service} task ${task.id} before submitting again` },
          };
          try {
            const state = await client(context.credentials).poll(task);
            if (state.status === "pending") return wakeAfter(canonicalize(task), interval);
            const r = state.response;
            const urls = service === "kie" ? r.resultUrls : mapping.result === "image"
              ? (Array.isArray(r.images) ? r.images.map(i => object(i).url) : []) : [object(r.video).url];
            if (!Array.isArray(urls) || !urls.length) throw new Error("Completed task has no output media");
            return { status: "ready", handle: canonicalize({ ...task, urls: urls.map(publicUrl) }), receipt: { id: task.id } };
          } catch (error) {
            if (!(error instanceof CloudError)) throw error;
            // Only read-only reconciliation may be retried; the original task remains named.
            if (error.code === "TRANSPORT" || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500) return wakeAfter(canonicalize(task), interval);
            return { status: "failed", receipt: { id: task.id }, failure: { code: error.code, message: error.message } };
          }
        },
        async collect(context) {
          const task = handle(context.handle), urls = object(context.handle).urls;
          if (!Array.isArray(urls) || !urls.length) throw new Error("Task has no output URLs");
          const artifacts = [];
          for (const value of urls) {
            // Never forward account authorization to a media host.
            const response = await fetcher(publicUrl(value), { signal: AbortSignal.timeout(120_000) });
            if (!response.ok) throw new Error(`Output download failed (HTTP ${response.status})`);
            const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
            if (!mediaType?.startsWith(`${mapping.result}/`)) throw new Error("Provider returned a wrong media type");
            artifacts.push(await context.resources.put(new Uint8Array(await response.arrayBuffer()), mediaType));
          }
          return { status: "completed", receipt: { id: task.id }, result: { value: { kind: "inline", value: canonicalize(mapping.result === "image"
            ? sealGeneratedImageSet({ images: artifacts }) : sealGeneratedVideoSet({ videos: artifacts })) } } };
        },
      };
      return { capability: mapping.capability, returns: mapping.result === "image" ? generationTypes.imageSet : generationTypes.videoSet,
        lifecycle: "asynchronous" as const, supports: (request: Parameters<typeof support>[2]) => support(service, mapping, request), endpoint };
    }),
  });
}
