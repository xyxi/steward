---
kind: upgrade-guide
description: "Steward removes the added depth camera and uses RGB-only recordings for NovelAnything."
---

# Steward RGB-only recording and NovelAnything inputs

English | [中文](guide.zh.md)

## Change

Steward removes the separate `head_depth_camera`, `--depth-camera-extrinsics` option and depth fields from camera capture/calibration responses. NovelAnything robot inputs use only middle `head_camera` RGB with poses and intrinsics; prepared ZIPs omit depth files and `depth_path`. The model still predicts target RGB and depth. The original `/sensors/rgbd` perception stream continues to use the original head camera.

## Migration

1. Remove `--depth-camera-extrinsics` from launch commands. Rebuild the Steward plugins with `pnpm --dir steward/dsh run build` from the repository root, then restart Steward and robot chat to load the Python and plugin changes. Restarting loses live recording handles; retain any needed local archives first.
2. Replace `ego_rgbd_recording_start/status/stop` with `ego_rgb_recording_start/status/stop`. HTTP recording routes change from `/sensors/rgbd/record/*` and `/ego/rgbd/record/*` to `/sensors/rgb/record/*` and `/ego/rgb/record/*`; the preparation route is `/ego/rgb/prepare-novelanything`. New handles begin with `rgb_`.
3. Use `novelanything_prepare_gripper_view` on a successful RGB recording and upload its returned ZIP. Confirm `metadata.input_modalities` equals `["rgb"]` and the archive contains no `depth_path` or depth images. The remote deployment must support RGB-only inputs (API 1.3.0 or later); do not add depth to work around an older server.
