import { createRuntimeEndpointAdapterFacet, runtimeConfigCredentialRef, runtimeConfigExact, runtimeConfigObject, runtimeConfigPositiveInteger } from "@hypit/runtime-local/extension";
import { createKieFalProvider } from "./provider.js";

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [createRuntimeEndpointAdapterFacet({
    use: "@hypit/provider-kie-fal",
    activate(context) {
      const config = runtimeConfigObject(context.config, "KIE/fal");
      runtimeConfigExact(config, ["service", "apiKey", "defaultConcurrency", "pollIntervalMs", "operationTimeoutMs"], "KIE/fal");
      const service = config.service;
      if (service !== "kie" && service !== "fal") throw new Error("service must be kie or fal");
      const apiKey = runtimeConfigCredentialRef(config.apiKey, "KIE/fal apiKey");
      if (!apiKey || !context.pool) throw new Error("KIE/fal apiKey and pool are required");
      const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "defaultConcurrency") ?? 1;
      const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "pollIntervalMs") ?? 2_000;
      const operationTimeoutMs = runtimeConfigPositiveInteger(config.operationTimeoutMs, "operationTimeoutMs") ?? 1_800_000;
      return { endpoint: createKieFalProvider({ service, instance: context.instance, pool: context.pool, apiKey, defaultConcurrency, pollIntervalMs, operationTimeoutMs }) };
    },
  })],
};
export default hypitPackage;
