---
name: slarm
description: Reconstruct a scene over time with SLARM from calibrated three-camera image sequences. Use for 4D reconstruction, point clouds and reconstruction videos in either the World Harness or robot Ego Harness.
---

# SLARM scene reconstruction

SLARM accepts a compliant ZIP with three camera images per time point, pixel calibration, known camera poses and timestamps. Reconstruction uses a half-open range of 16–256 time frames; three simultaneous images are one time point, not three frames. A plain video or a single ego_capture_cameras snapshot does not supply this sequence. Do not pad frames, invent camera poses or substitute generated RGBD predictions for observations.

Choose inputs within the calling harness's permissions. World may use world_cameras, world_capture and world_capture_status to obtain a simulation sequence; wait for succeeded before submitting its archive_path as slarm_scene_v1. Label these poses as simulation ground truth. Robot may submit a supplied compliant ZIP beneath its workspace, using its own observed images and known or estimated poses. Robot must not use World tools or simulator files to obtain hidden state. If a required sequence or trajectory is unavailable, explain the missing input instead of delegating filesystem work or reporting a hardware fault.

Check slarm_capabilities, upload with slarm_upload, and wait for the dataset to become ready using slarm_dataset_status. Submit slarm_reconstruct with the requested range and outputs. Preserve request_key and arguments after an uncertain POST. Poll slarm_status; only succeeded permits slarm_result. Failed, cancelled or expired tasks stop dependent processing. Remote cancellation requires slarm_cancel and confirmation of its final status.

Download every requested output with slarm_download; select all pointcloud artifacts when reconstruction spans multiple windows. The caller's DSH_HOME/workspace contains inputs/slarm, outputs/slarm/<reconstruction_id> and var/slarm recovery records. Keep local_manifest_path for downstream consumers; files in the local manifest have verified sizes and SHA256. Report remote completion and local download completion separately. No UI visualization is required.

Treat reconstruction geometry, semantics and motion as predictions. Point counts are not object counts; quality_status=ok does not establish accuracy. Windows are not globally fused. Do not automatically merge predictions into World State or Ego State, and do not use them as a robot motion receipt.
