---
kind: upgrade-guide
description: "Steward model downloads use workspace output directories and retain submitted inputs separately from recovery state."
---

# Steward model input and output directories

English | [中文](guide.zh.md)

## Change

Steward SLARM and rgbd_video_gen clients save results in `outputs/slarm/<reconstruction_id>/` and `outputs/rgbd_video_gen/<job_id>/` beneath the caller’s `DSH_HOME/workspace/` (`var/dsh/world/workspace` or `var/dsh/robot-1/workspace`), instead of endpoint-hashed directories under `stateDir`. RGBD artifacts are directly inside the task directory. SLARM retains artifact-ID subdirectories to avoid filename collisions. Both tools return `local_manifest_path` for a local `manifest.json` containing verified file paths and input references.

Submissions archive JSON scenes and parameters or uploaded ZIPs under the corresponding `inputs/<model>/` directory. Gripper preparation defaults to `inputs/rgbd_video_gen/prepared/`. Server demos retain their selector, not server-owned evidence images. Historical submissions without local input records have a null input reference. Existing legacy files are not deleted or automatically moved.

## Migration

1. Restart Steward to load the client changes. Move legacy World `var/slarm` recovery records into `var/dsh/world/workspace/var/slarm`, preserving idempotency keys and updating local path references; robot recovery records already reside in its workspace. The SLARM bundle derives all three storage directories from `DSH_HOME`; both World and robot profiles now install its skill. Set `inputsDir` and `outputsDir` in the model client profile row to override the defaults; relative paths resolve beneath `inputRoot`. Different endpoints with colliding task IDs need separate output directories.
2. Replace downstream path concatenation with the tool-returned `local_manifest_path`. Read `files` for verified downloads; read RGBD `targets` for target camera, RGB and depth array associations. A null path means that file has not been downloaded.
3. Query and download an existing successful task to publish it in the new directory, or copy historical files and verify them against the server result before using them. Retain existing files until consumers use the new manifest. A new submission preserves its inputs before POST.
4. Confirm that a downloaded task has `result.json`, `manifest.json` and verified files under `outputs/<model>/`. Move legacy Steward-root `inputs/slarm` and `outputs/slarm` into the World workspace and update manifest paths before removing the empty root directories. The existing `var/` Git ignore rule covers all caller files.
