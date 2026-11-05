import { compileWireRequest, mappingSupportsRequest, selectWireModelForRequest, verifyPortsAgainstTable } from "@hypit/generation";
import type { GenerationRequest, GenerationWireMapping, GenerationArtifactUrlResolver } from "@hypit/generation";
import { nanoBananaPorts } from "@hypit/nano-banana";
import { grokImaginePorts } from "@hypit/grok-imagine";
import { seedancePorts } from "@hypit/seedance";
import type { EndpointRequest, EndpointSupport } from "@hypit/hypit/endpoint";
import type { Service } from "./client.js";
import { object } from "./client.js";

const nano = (service: Service): GenerationWireMapping => ({
  capability: { module: { name: "@hypit/nano-banana", version: "1" }, name: "nano-banana-2" }, result: "image",
  routes: service === "kie" ? [{ model: "nano-banana-2" }] : [{ model: "fal-ai/nano-banana-2/edit", whenPresent: ["images"] }, { model: "fal-ai/nano-banana-2" }],
  fields: { prompt: { as: "value", field: "prompt" }, images: { as: "urlArray", field: service === "kie" ? "image_input" : "image_urls" },
    aspectRatio: { as: "value", field: "aspect_ratio" }, resolution: { as: "value", field: "resolution" }, outputFormat: { as: "value", field: "output_format" } },
});
const grok: GenerationWireMapping = {
  capability: { module: { name: "@hypit/grok-imagine", version: "1" }, name: "grok-imagine-video" }, result: "video",
  routes: [{ model: "xai/grok-imagine-video/image-to-video", whenPresent: ["images"] }, { model: "xai/grok-imagine-video/text-to-video" }],
  fields: { prompt: { as: "value", field: "prompt" }, images: { as: "urlArray", field: "image_urls" }, aspectRatio: { as: "value", field: "aspect_ratio" },
    resolution: { as: "value", field: "resolution" }, duration: { as: "value", field: "duration" } },
};
const seedance: GenerationWireMapping = {
  capability: { module: { name: "@hypit/seedance", version: "1" }, name: "seedance-2-mini" }, result: "video", routes: [{ model: "bytedance/seedance-2-mini" }],
  fields: { prompt: { as: "value", field: "prompt" }, aspectRatio: { as: "value", field: "aspect_ratio" }, resolution: { as: "value", field: "resolution" },
    duration: { as: "value", field: "duration" }, generateAudio: { as: "value", field: "generate_audio" }, webSearch: { as: "value", field: "web_search" },
    firstFrame: { as: "url", field: "first_frame_url", resourceFields: ["personReference"] }, lastFrame: { as: "url", field: "last_frame_url", resourceFields: ["personReference"] },
    referenceImage: { as: "urlArray", field: "reference_image_urls", resourceFields: ["personReference"] }, referenceVideo: { as: "urlArray", field: "reference_video_urls", resourceFields: ["personReference"] },
    referenceAudio: { as: "urlArray", field: "reference_audio_urls" } },
};
export const mappings = { kie: [nano("kie"), seedance], fal: [nano("fal"), grok] } as const;
export function support(service: Service, mapping: GenerationWireMapping, need: EndpointRequest): EndpointSupport {
  try {
    const request = need.constraints as unknown as GenerationRequest;
    const table = mapping.result === "image" ? nanoBananaPorts["nano-banana-2"] : service === "kie" ? seedancePorts["seedance-2-mini"] : grokImaginePorts["grok-imagine-video"];
    verifyPortsAgainstTable(table, request.ports, { defer: need.pendingInputs?.map(i => i.input) ?? [] });
    if (!mappingSupportsRequest(mapping, request)) throw new Error("Unmapped generation port");
    selectWireModelForRequest(mapping, request, need.pendingInputs?.map(i => i.input));
    const n = (request.ports.images?.length ?? 0) + (need.pendingInputs?.filter(i => i.input === "images").length ?? 0);
    if (service === "kie" && mapping.result === "image" && n > 10) throw new Error("KIE Nano Banana 2 accepts at most 10 images");
    if (service === "fal" && mapping.result === "video" && n > 1) throw new Error("fal Grok accepts at most one input image");
    if (service === "fal" && mapping.result === "video" && request.ports.resolution?.[0] === "1080p") throw new Error("fal Grok offers 480p or 720p");
    if (service === "kie" && mapping.result === "video" && request.ports.webSearch?.[0] === true) throw new Error("KIE Seedance Mini has no web search control");
    return { status: "supported" };
  } catch (error) { return { status: "unsupported", reason: error instanceof Error ? error.message : "Invalid generation request" }; }
}
export async function compile(service: Service, mapping: GenerationWireMapping, request: GenerationRequest, resolve: GenerationArtifactUrlResolver) {
  const wire = await compileWireRequest(mapping, request, resolve);
  const input = { ...object(wire.input) };
  if (service === "fal" && input.output_format === "jpg") input.output_format = "jpeg";
  if (service === "fal" && mapping.result === "video" && input.image_urls !== undefined) {
    input.image_url = (input.image_urls as string[])[0]; delete input.image_urls;
  }
  if (service === "kie" && mapping.result === "video") delete input.web_search;
  return { model: selectWireModelForRequest(mapping, request), input };
}
