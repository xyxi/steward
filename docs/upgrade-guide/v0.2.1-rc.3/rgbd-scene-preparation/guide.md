---
kind: upgrade-guide
description: "rgbd_video_gen replaces gripper-only scene preparation with explicit targets and middle RGB evidence by default."
---

# General RGBD scene preparation

English | [中文](guide.zh.md)

## Change

`rgbd_video_gen_prepare_scene` replaces `rgbd_video_gen_prepare_gripper_view`. The service method is `prepareScene(captureManifest, options, signal)` instead of `prepareGripperView`. Preparation defaults to one middle `head_camera` RGB image, rather than three evidence cameras. Target viewpoints are explicit; no gripper target is chosen implicitly. Existing downloaded results remain valid.

## Migration

1. Replace the tool or service method name. Supply `targets` with one to 24 entries. Each entry names `frame` (`reference` for the captured middle OpenCV frame, or `gripper` for synchronized forward/left/up axes) and either a rigid OpenCV `camera_to_frame` matrix or all three `position`, `look_at`, `up` vectors. Positions are metres. Do not mix both forms.
2. For the former gripper-forward viewpoint, pass `targets:[{frame:"gripper",position:[0,0,0],look_at:[1,0,0],up:[0,0,1]}]`. Gripper targets require the same-timestamp embedded pose; reference targets do not require a gripper pose.
3. Omit `source_cameras` for middle RGB only. To retain three-camera evidence, explicitly pass `["head_camera_left","head_camera","head_camera_right"]`. Only selected JPEGs are loaded; selected cameras must share middle-camera resolution and intrinsics.
4. Submit the returned `scene_path` with the exact returned `num_source_views` and `max_target_views`. One source and one target produce 2 frames and require `num_source_views=1`; the remote submission default remains 6. Scene files use `scene-<hash>.json` under the prepared input directory. Verify the saved scene metadata lists only `head_camera` for the default case.
5. For motion evidence, start and stop an RGB recording around independently controlled navigation, then call `rgbd_video_gen_prepare_recording` with the successful handle and explicit targets. The provider requires the robot Ego service and Python `/ego/rgb/record/export` endpoint; rebuild plugins and restart Steward/robot chat to load both changes. Save needed live recording evidence before restarting. Recordings of at most eight frames use all frames by default; longer recordings use eight uniformly spaced frames including both endpoints. Explicit counts or batch indices override the default; verify the prepared source indices and all_frames_used instead of treating local retention as model input.
