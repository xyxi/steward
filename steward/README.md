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

On Windows, after installing local dependencies and creating profiles, double-click `run_windows.bat` to launch the world and robot services. It sets the local Python dependency path and uses the base Python interpreter for robot subprocesses.

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

The robot camera card starts in single-camera mode. Its button switches to three synchronized views ordered left, original, right. The original `head_camera`, robot RGB/RGB-D routes and perception input stay unchanged. Side cameras copy the original intrinsics and orientation and sit 0.12 m to either side; `steward up --camera-offset 0.15` changes that per-side distance. They add no geometry, mass or collision. Triple-view rendering runs on a private physics snapshot and its own rendering thread; single mode does not render the side cameras. A failed switch retains the previous mode and reports an error in the card.

The World Control API exposes `GET/POST /wca/cameras` (robot, mode) and `GET /wca/cameras/frame?robot=w:robot-1` (one or three JPEG images with a shared simulation time, pixel K and OpenCV camera-to-world transforms in metres). These poses are labelled simulator truth and are not exposed through the robot sensor port. Head-camera resolution is retained for triple snapshots.

## Remote 4D reconstruction

The World Harness uses SLARM tools to upload compliant Waymo ZIPs, submit reconstruction, query progress, cancel tasks and download point clouds and videos with size and SHA256 verification. On Windows run `.\scripts\setup-slarm.ps1`, restart Steward, then provide the ZIP path in the World Harness chat. See the [SLARM guide](dsh/packages/dsh-bundle-slarm/README.md) for input requirements, example prompts and storage locations.
