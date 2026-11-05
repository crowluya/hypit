# @hypit/provider-kie-fal

Native Hypit Endpoints for explicit KIE/fal account selection. See
`docs/zh/guide/kie-fal-breakdown.md` and `examples/kie-fal.runtime.json`.

Supports Nano Banana 2 through both services, KIE Seedance Mini and fal Grok Imagine Video.
Checks service limitations, checkpoints accepted task IDs, polls existing work, and collects
media without sending API credentials to output hosts. Keys stay in a selected CredentialStore.
No automatic submission retries or cross-provider fallback.

`./client` also exposes upload, queued utility tasks and synchronous KIE Gemini analysis for
the reference-analysis command. It is not a declaration that every service model is supported.
