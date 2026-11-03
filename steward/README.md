# Steward

English | [中文](README.zh.md)

Steward is an embodied robotics system built on DeepSeek Harness. See [steward.md](../steward.md) for the design and its “13. Implementation Progress” section for implementation progress and launch commands.

## Quick start

```sh
uv sync
.venv/bin/steward demo          # 构建厨房并运行「把杯子放到桌上」，按 World State 判定成败
.venv/bin/steward up            # 常驻运行世界与机器人（默认循环搬运场景 phase0-shuttle）
open http://127.0.0.1:7400/console   # 浏览器控制台：斜视主视图、相机、地图、指标、控制
.venv/bin/steward shuttle --api http://127.0.0.1:7420 --steps 0   # 在餐桌、柜子、餐边柜之间循环搬运
./scripts/check.sh              # Python 测试、DSH 插件编译与测试、组合配置快照比对
```

## Run with DeepSeek Harness

On Windows, after installing local dependencies and creating profiles, double-click `run_windows.bat` to launch the world and robot services. It sets the local Python dependency path and uses the base Python interpreter for robot subprocesses. Each service owns its port exclusively. On Windows, `steward up` checks its configured WCA, robot and Ego API ports, stops an existing Steward instance from this checkout together with its descendants, waits for exit and starts the replacement. When Windows reports listener PID 0, startup verifies the instance PID and process creation time from `var/dsh/instances/<port>.json`, together with its command and checkout. Listeners with no verified ownership, from other programs or from other checkouts are kept and reported as a startup error. Requested port 0 remains dynamically allocated. Replacing an instance resets its in-memory simulation and running tasks; files are retained.

```sh
echo 'DEEPSEEK_API_KEY=sk-...' > .env     # 已被 Git 忽略，运行脚本自动加载
.venv/bin/steward up                      # WCA :7400，机器人端口 :7410，Ego API :7420
./scripts/setup-dsh-profiles.sh           # 构建插件，创建 ego、world、world-task profile
./scripts/run-ego.sh "把杯子放到桌上"       # 机器人智能体
./scripts/run-world.sh "按描述构建一间厨房……"  # World Harness 一次性任务
./scripts/run-world.sh --port 3091        # World Harness 浏览器界面
```

The `ego` profile is the robot's Ego Harness: it observes and acts through the Ego API, with general shell, file and web tools disabled. The `world` and `world-task` profiles build assets, compose scenes and control Episodes through the World Control API. Robot and world profiles use separate `DSH_HOME` directories.

Console chat uses `dsh.cmd` on Windows and `dsh` on macOS/Linux, with UTF-8 prompts and run events. Stopping robot chat terminates its Harness process tree and returns control after requesting that robot actions stop. The console reports a failed action-stop request.

The robot's DeepSeek API-key route retries transient model failures, including `STREAM_CLOSED` when a response ends before `message_stop`, up to five times per model step with backoff. Completed tool calls stay committed; incomplete responses do not execute tools. Exhausted retries still fail visibly. The policy is configurable through `llm-deepseek.config.retryPolicy` in the robot profile's `cordis.patch.yml`.

A browser refresh, client timeout or cancellation can interrupt a local HTTP response. JSON, binary and 204 responses end their connection on a broken pipe, reset or abort without printing an unhandled server traceback. Other I/O failures and route errors retain normal reporting. A disconnected response neither rolls back nor repeats a route handler; inspect operation status before repeating a command.

## Directory layout

| Path | Contents |
|---|---|
| `src/steward/scene` | SceneState, validators and MJCF conversion shared by WS and ES |
| `src/steward/assets`, `authoring` | Asset generation, validation, previews and catalog; scenes and Scenarios |
| `src/steward/world` | WSim and Steward host (WCA and robot ports) |
| `src/steward/ego` | Ego Runtime: estimator, ESim, skills and Ego API |
| `src/steward/observer` | Comparison of ES with World State |
| `dsh/` | DeepSeek Harness plugins and bundles pinned to `@deepseek-ai/dsh@0.2.1-rc.3` |
| `scripts/` | Profile setup, checks and multi-seed regression |
| `compat/snapshots` | Composed configuration snapshots |

Runtime data lives in `var/` and is excluded from version control.

## Camera modes

The robot camera card starts in single-camera mode. Its button switches to three synchronized views ordered left, original, right. The original `head_camera`, robot RGB/RGB-D routes and perception input stay unchanged. Side cameras copy the original intrinsics, sit 0.12 m to either side and turn outward by 25° each to expand coverage. `--camera-offset` changes the per-side distance in metres; `--camera-yaw` sets the outward angle from 0° (parallel) to 60°. They add no geometry, mass or collision. Triple-view rendering runs on a private physics snapshot and its own rendering thread; single-camera preview does not render the side cameras; robot captures render them on demand. A failed switch retains the previous mode and reports an error in the card.

The World Control API exposes `GET/POST /wca/cameras` (robot, mode) and `GET /wca/cameras/frame?robot=w:robot-1` (one or three JPEG images with a shared simulation time, pixel K and OpenCV camera-to-world transforms in metres). These poses are labelled simulator truth and are not exposed through the robot sensor port. Head-camera resolution is retained for triple snapshots.

## Robot three-camera capture

Ask the robot: “Stay still and capture the current left, original and right camera images, then report the shared timestamp and saved paths.” The `ego_capture_cameras` sensor tool saves three JPEGs and `capture.json` under `var/camera-captures` in the robot workspace. It works in both console display modes. The images share one sensor timestamp; calibration includes pixel K and `camera_to_reference` in OpenCV axes and metres, relative to the original head camera. The robot receives these through its sensor port and Ego API, without absolute simulator poses. Configure the Ego provider with `cameraCaptureDir` and `cameraMaxBytes` to change the save directory and total RGB image byte limit (default 16 MiB). The [rgbd_video_gen guide](dsh/packages/dsh-bundle-rgbd-video-gen/README.md) describes the general scene preparation tool (middle RGB by default, explicit target viewpoints) and submission tools.

The `ego_gripper_pose` tool reads current joint encoders and fixed rig calibration without taking images or moving. Robot-owned forward kinematics returns `gripper_to_base` and one `gripper_to_camera` matrix for each camera, all in metres. These matrices map a point from the gripper link origin, with x forward/y left/z up, into the base or the selected OpenCV camera frame (x right/y down/z forward). This is the gripper link frame, not a camera frame. `ego_capture_cameras` also saves `gripper_pose` from the same encoder timestamp as its three images; use that embedded pose for image synthesis rather than combining separate queries taken while the robot may move.

The agent can start `ego_rgb_recording_start` before motion, let it record middle-camera RGB at a simulation-time FPS (default 2), and finish with `ego_rgb_recording_stop`. Model response speed does not set the sensor cadence. `ego_rgb_recording_status` reports saved counts, timestamps and failures. These tools perform no navigation; the agent continues to use prediction receipts and motion tools independently. For NovelAnything, `novelanything_prepare_gripper_view` converts the finished recording into a local scene/evidence ZIP and a current gripper target using measured odometry and fixed calibration. `ego_camera_calibration` provides RGB intrinsics and fixed relative transforms without imaging. See the [NovelAnything guide](dsh/packages/dsh-bundle-novelanything/README.md).

For rgbd_video_gen motion evidence, use `rgbd_video_gen_prepare_recording` on the completed recording instead of preparing a final camera snapshot. It retains all frames locally and reports exactly which chronological frames condition each remote job; see its guide for the default all-frames-or-eight policy and explicit selection overrides.

## Remote 4D reconstruction

Both World and robot Ego Harnesses provide the `slarm` skill and SLARM tools. They use inputs within their own permissions and do not automatically merge predictions into state. Each caller uses SLARM tools to upload compliant ZIPs, submit reconstruction, query progress, cancel tasks and download point clouds and videos with size and SHA256 verification. On Windows run `.\scripts\setup-slarm.ps1`, restart Steward, then provide a compliant ZIP path to the selected harness. Robot inputs stay beneath its workspace; a single camera snapshot is not a 16-frame time sequence. See the [SLARM guide](dsh/packages/dsh-bundle-slarm/README.md) for input requirements, example prompts and storage locations.

In triple mode, **采集 16 帧** records 48 images at 10 simulation frames per second and displays progress, cancellation and the completed ZIP path. To run the whole flow, ask World Harness: “Use w:robot-1's three cameras to capture 16 frames at 10 fps, reconstruct them with SLARM, and download all point clouds and both videos.” The simulator must be advancing; capture does not command robot motion. Camera switching is locked during capture. The [SLARM guide](dsh/packages/dsh-bundle-slarm/README.md#use-this-package) documents recording limits, coordinates and failure recovery.

## Novel-view RGB/depth generation

Only the robot Ego Harness has the `rgbd-video-gen` skill and can call `rgbd_video_gen` to submit scenes or server demos, query and cancel jobs, and download verified results. On Windows run `.\scripts\setup-rgbd-video-gen.ps1`, then restart the robot chat. See the [rgbd_video_gen guide](dsh/packages/dsh-bundle-rgbd-video-gen/README.md) for input formats, demo usage and server configuration.

The robot Ego Harness also provides `novelanything` for remote NovelAnything view synthesis from RGB-only inputs. On Windows run `.\scripts\setup-novelanything.ps1`, then restart robot chat. It uses only the middle RGB `head_camera` and requires a compliant posed RGB-only ZIP without depth files or depth_path fields; multiple contexts must come from different timestamps/poses of this same camera, excluding both side cameras. See the [NovelAnything guide](dsh/packages/dsh-bundle-novelanything/README.md) for scene units, task recovery and output paths. World profiles do not install it.

Model files stay beneath `var/dsh/<caller>/workspace/`, with `<caller>` equal to `world` or `robot-1`: `inputs/rgbd_video_gen/`, `inputs/novelanything/` and `inputs/slarm/` retain submitted inputs; `outputs/rgbd_video_gen/<job_id>/`, `outputs/novelanything/<job_id>/` and `outputs/slarm/<reconstruction_id>/` retain results. Each result directory contains `manifest.json` with absolute local file paths for downstream consumers. These input and output directories are ignored by Git. Request recovery records stay in that caller workspace under `var/`; Steward does not create root-level `inputs/` or `outputs/` directories.
