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

For the running simulation, use `world_cameras` to select `triple`, `world_capture` to start recording and `world_capture_status` to wait for `succeeded`. Pass its `archive_path` to `slarm_upload` with `format: "slarm_scene_v1"`, then follow the same validation, reconstruction and download steps. `world_capture_cancel` requests local recording cancellation; only a `cancelled` status confirms cleanup. Stopping chat stops waiting but leaves an accepted recording running. After a lost start response, query `world_cameras` for the latest capture before starting another.

Recording accepts 16–256 synchronized time points at 1–30 fps, provided the sampling period is an integer number of physics steps (10 fps works with the default step). Its bounded queue copies simulation states; image rendering and ZIP packaging run on a separate thread. Queue overflow, scene replacement and a 120-second wall-clock timeout fail visibly. Pause the robot's motion independently if required; pausing the simulation prevents recording progress. A host permits one recording at a time, and the camera-mode button stays locked until cleanup completes.

The ZIP contains `scene.json` and three PNGs per time point, named `camera_0_left`, `camera_1_center` and `camera_2_right`. Calibration uses original image pixels; poses use OpenCV axes (right, down, forward), metres, and camera-to-world matrices. The original camera is the reference. Poses are **simulation ground truth**, not SLAM estimates. Dataset times start at zero with spacing `1/fps`; metadata preserves the original simulation start time. Result coordinates use the requested starting reference camera's FLU frame (forward, left, up); use the result's `coordinates.T_world_scene` for world alignment, especially when reconstructing a subrange. Predictions are not automatically merged into World State or Ego State.

Exports persist under `<Steward root>/captures/<capture_id>/scene.zip` (normally `var/steward/captures/`). Only successful recordings return an archive path; partial images may remain for diagnosis. Capture handles are process-local and expire on restart, but completed ZIPs remain reusable. WCA routes are `POST /wca/capture` (`robot`, `frames`, `fps`), `GET /wca/capture?capture_id=…&wait_seconds=…` (0–20 seconds), and `POST /wca/capture/cancel` (`capture_id`). These privileged routes are unavailable on robot sensor ports.

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

This integration supports `waymo_slarm_v1`, `slarm_scene_v1` and result schema `1.0` against API 0.4.0. It does not convert ordinary videos, estimate camera poses, fuse windows into a scene, or import predictions into MuJoCo. Equal camera intrinsics and synchronized images do not establish reconstruction accuracy; view overlap, baseline and the model's training domain still matter.


-----

<a id="dev-note"></a>
## Dev Note

None.
