---
description: "Agent-facing SLARM upload, reconstruction, status, cancellation and download behavior."
kind: "package-reference"
---

# @steward/dsh-tool-slarm

English | [中文](README.zh.md)

## Summary

Ask the World Harness to reconstruct a compliant ZIP and report verified results. The tools separate accepted submissions, terminal reconstruction state and local download success. They preserve model-input counts and warnings so that completion is not mistaken for accuracy.

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

Install the [bundle](../dsh-bundle-slarm/README.md) and use the World chat. The ordinary DSH tool panel displays each named call and its JSON result; binary artifacts remain local files.

The agent reads `slarm_capabilities`, uploads with `slarm_upload`, and queries `slarm_dataset_status` until ready. It submits with `slarm_reconstruct`, follows `slarm_status`, and reads `slarm_result` only after success. `slarm_download` accepts artifact ids from that result. `slarm_cancel` explicitly requests remote cancellation. Exact parameters and descriptions are in [src/index.ts](src/index.ts).

Upload and reconstruction require stable `request_key` values. Polling waits default to zero; `evaluate` defaults to false. Outputs must be selected explicitly. Use all pointcloud artifact ids when a reconstruction spans several windows.

Only `completed: true` from a validated result permits reporting reconstruction complete. Only verified download receipts permit reporting local files ready. `cancelling` is pending; a `cancelled` status confirms cancellation. An expired result or failed transfer must be reported separately from reconstruction success.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

Tools register through plugin effects and call the injected `slarm` service with the turn cancellation signal. The standard DSH tool pipeline records their JSON output. There is no custom agent loop or browser-only result state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Steward](../../../README.md) · [Service types](../dsh-slarm/README.md) · [HTTP provider](../dsh-slarm-client/README.md) · [Tools](../dsh-tool-slarm/README.md) · [Bundle](../dsh-bundle-slarm/README.md)


-----

<a id="model-experience"></a>
## Model Experience

Tool descriptions distinguish frame sampling, terminal states and artifact selection. Results include actual model-call counts, distinct input images, input occurrences and output views. Null metrics remain null. Geometry, semantics and motion are predictions; point counts do not count objects, and `quality_status=ok` does not establish accuracy. Tool schemas are stable; per-task JSON grows conversation history and may affect subsequent prompt-cache reuse.


-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

No instance tracking, object segmentation claims, fused world scene or automatic robot action is provided. Stopping a turn does not request remote cancellation. Downloads are file references, not embedded 3D viewers.


-----

<a id="dev-note"></a>
## Dev Note

None.
