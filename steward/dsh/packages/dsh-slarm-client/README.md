---
description: "HTTP provider settings, durable submission identities and verified artifact storage for SLARM reconstruction."
kind: "package-reference"
---

# @steward/dsh-slarm-client

English | [中文](README.zh.md)

## Summary

Upload local Waymo ZIPs to a SLARM server and retrieve completed reconstructions. Stable request keys recover submissions after lost responses. Downloads stream to disk and become complete files only after size and SHA256 verification.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install through the [bundle](../dsh-bundle-slarm/README.md). Customize its `steward-slarm-api` row using a DSH profile patch; the provider does not read or forward `DEEPSEEK_API_KEY`.

| Setting | Default | Meaning |
|---|---|---|
| `endpoint` | Required | HTTP(S) API base, retaining `/slarm` where deployed |
| `inputRoot` | Required | Existing directory containing allowed ZIPs |
| `stateDir` | Required | Local request records, manifests and downloads |
| `requestTimeoutMs` / `uploadTimeoutMs` / `downloadTimeoutMs` | 15000 / 1800000 / 300000 | Per-attempt timeouts |
| `pollIntervalMs` / `maxWaitSeconds` | 2000 / 20 | Poll spacing and maximum requested wait |
| `retryCount` / `retryDelayMs` / `maxRetryDelayMs` | 2 / 1000 / 30000 | Additional HTTP attempts, initial backoff and maximum accepted delay |
| `maxMetadataBytes` | 2097152 | Maximum JSON response size |
| `maxUploadBytes` / `maxArtifactBytes` | 2147483648 each | Local per-archive and per-artifact size limits |

Relative directories resolve from the launch directory. ZIP paths are resolved beneath `inputRoot`, including symlink resolution. The server upload limit also applies. A wait may exceed its requested duration while the current HTTP request and bounded retries settle.

Reuse the same `request_key` and options after an uncertain submission. The local store reserves an idempotency key before POST and refuses to reuse that identity for different contents. Preserve the store across restarts; a new key represents new work.

Each endpoint has a separate directory named by its SHA256 prefix. `results/<reconstruction_id>/result.json` holds the full manifest; `<artifact_id>/<filename>` holds each verified download. Receipts record file paths, sizes and hashes. Downloading again reuses verified complete files; partial downloads restart from the beginning.

HTTP failures stop dependent work. Permanent errors are not retried; eligible transient errors use bounded backoff and respect `Retry-After`. A delay above the configured cap is reported instead of retrying early. Remote expiry does not delete downloaded local files.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

[src/index.ts](src/index.ts) owns requests, polling and downloads; [src/protocol.ts](src/protocol.ts) validates HTTP metadata; [src/storage.ts](src/storage.ts) atomically publishes local records. Disposal aborts local operations and awaits their cleanup. Accepted remote jobs survive disposal and can be recovered with the same local store.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Steward](../../../README.md) · [Service types](../dsh-slarm/README.md) · [HTTP provider](../dsh-slarm-client/README.md) · [Tools](../dsh-tool-slarm/README.md) · [Bundle](../dsh-bundle-slarm/README.md)


-----

<a id="model-experience"></a>
## Model Experience

Indirect: the [tools](../dsh-tool-slarm/README.md) expose bounded JSON results. The complete result manifest stays on disk.


-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Cancellation requires a submission created or recovered in this store. Artifact transfers do not implement HTTP Range resume or automatic download retries. The client does not unpack ZIPs or interpret NPZ arrays.


-----

<a id="dev-note"></a>
## Dev Note

None.
