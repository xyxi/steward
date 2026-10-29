---
description: "SLARM profile layer for uploading Waymo ZIPs and retrieving remote 4D reconstruction results in Steward."
kind: "package-bundle"
---

# @steward/dsh-bundle-slarm

English | [中文](README.zh.md)

## Summary

Add remote 4D reconstruction to the World Harness. The layer provides upload, progress, cancellation and verified artifact downloads. Install it into the world profiles and give the agent a local Waymo ZIP; the reconstruction model runs on the configured server.

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

From the Steward directory, with its DSH dependencies available, run the Windows installer below. It builds the local plugins and adds the bundle to `world` and `world-task` under `var/dsh/world`. Existing profile settings remain in place.

```powershell

.\scripts\setup-slarm.ps1

```

The [complete profile installer](../../../scripts/setup-dsh-profiles.sh) also installs this layer on macOS/Linux. Restart Steward with `run_windows.bat` after updating the World chat instructions, open the console and select **World Harness**.

Put a compliant ZIP at `var/input/scene.zip`, then send:

> Reconstruct frames [0,16) from var/input/scene.zip. Request pointcloud, rgb_video and diagnostic_video. Follow validation and progress until completion, download all point clouds and both videos, and report the actual input count, output views and verified local paths.

A compliant archive contains preprocessed Waymo images from three cameras, calibration, known poses and timestamps. Reconstruction accepts 16–256 time frames; `[0,16)` uses frames 0 through 15. A plain video ZIP is not this input format.

To resume, supply the returned `dataset_id` or `reconstruction_id`. To stop remote work, explicitly ask “Cancel reconstruction rec_… and confirm its final status.” Stopping chat only stops local waiting.

Use the [client settings](../dsh-slarm-client/README.md#use-this-package) to change the server or directories. The defaults are `http://115.120.57.9/slarm`, input root `.` and state directory `var/slarm`, relative to the DSH launch directory. Launch from Steward or configure absolute directories.


-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details</summary>

[cordis.patch.yml](cordis.patch.yml) adds `steward-slarm-api` and `steward-tool-slarm`. It composes the HTTP provider and tools without changing the DSH agent loop. The robot profile does not include this bundle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

[Steward](../../../README.md) · [Service types](../dsh-slarm/README.md) · [HTTP provider](../dsh-slarm-client/README.md) · [Tools](../dsh-tool-slarm/README.md) · [Bundle](../dsh-bundle-slarm/README.md)


-----

<a id="model-experience"></a>
## Model Experience

Indirect: the [tool package](../dsh-tool-slarm/README.md) owns model instructions and JSON results.


-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

This integration supports `waymo_slarm_v1` and result schema `1.0`; it was exercised against API 0.4.0 using its compatible Waymo endpoints. It does not convert ordinary videos, fuse windows into a scene, or import predictions into MuJoCo.


-----

<a id="dev-note"></a>
## Dev Note

None.
