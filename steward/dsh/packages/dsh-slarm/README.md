---
description: "Shared SLARM service types, operation identities and errors for providers and tool consumers."
kind: "package-library"
---

# @steward/dsh-slarm

English | [中文](README.zh.md)

## Summary

Build a SLARM provider or consume one through `ctx.slarm`. The service exposes remote operations independently of tool presentation. Branded dataset, reconstruction and artifact ids keep their meanings distinct.

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

Import the service and request types from `@steward/dsh-slarm`. [src/index.ts](src/index.ts) defines each operation, its cancellation semantics and structured failures. Applications install the [bundle](../dsh-bundle-slarm/README.md); this library has no profile layer.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

`SlarmService` registers the `slarm` service name. Requests carry explicit resolved options and a stable operation key. JSON values preserve nulls, while `SlarmError` carries the error code, retryability, HTTP status and details.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Steward](../../../README.md) · [Service types](../dsh-slarm/README.md) · [HTTP provider](../dsh-slarm-client/README.md) · [Tools](../dsh-tool-slarm/README.md) · [Bundle](../dsh-bundle-slarm/README.md)


-----

<a id="model-experience"></a>
## Model Experience

Indirect: consumers choose which service results enter the conversation; the library sends no model request.


-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

A caller abort signal stops local I/O. It does not imply that the server rejected a submission or cancelled a job. Use the returned operation identity to recover or explicitly cancel.


-----

<a id="dev-note"></a>
## Dev Note

None.
