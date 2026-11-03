# Steward

[English](README.md) | 中文

Steward 是基于 DeepSeek Harness 的具身智能机器人系统。设计见仓库根目录的 [steward.md](../steward.md)，当前实现进度与运行命令见其中的「13. Implementation Progress」。

## 快速开始

```sh
uv sync
.venv/bin/steward demo          # 构建厨房并运行「把杯子放到桌上」，按 World State 判定成败
.venv/bin/steward up            # 常驻运行世界与机器人（默认循环搬运场景 phase0-shuttle）
open http://127.0.0.1:7400/console   # 浏览器控制台：斜视主视图、相机、地图、指标、控制
.venv/bin/steward shuttle --api http://127.0.0.1:7420 --steps 0   # 在餐桌、柜子、餐边柜之间循环搬运
./scripts/check.sh              # Python 测试、DSH 插件编译与测试、组合配置快照比对
```

## 与 DeepSeek Harness 一起运行

Windows 完成本地依赖安装和 profile 创建后，可双击 `run_windows.bat` 启动世界与机器人服务；该文件配置本地 Python 依赖路径，并让机器人子进程使用基础 Python 解释器。每个服务独占自己的端口。Windows 下 `steward up` 会检查配置的 WCA、机器人及 Ego API 端口，关闭本工程中占用这些端口的旧 Steward 实例及其子进程，等待退出后启动新实例。Windows 将监听者报告为 PID 0 时，启动流程会结合 `var/dsh/instances/<port>.json` 中的实例 PID、进程创建时间及其命令和工程目录核实身份。无法核实归属、其他程序或其他工程目录的监听进程会保留，并报告启动错误。端口设置为 0 时仍由系统动态分配。替换实例会重置内存中的仿真与执行中任务，保留已有文件。

```sh
echo 'DEEPSEEK_API_KEY=sk-...' > .env     # 已被 Git 忽略，运行脚本自动加载
.venv/bin/steward up                      # WCA :7400，机器人端口 :7410，Ego API :7420
./scripts/setup-dsh-profiles.sh           # 构建插件，创建 ego、world、world-task profile
./scripts/run-ego.sh "把杯子放到桌上"       # 机器人智能体
./scripts/run-world.sh "按描述构建一间厨房……"  # World Harness 一次性任务
./scripts/run-world.sh --port 3091        # World Harness 浏览器界面
```

`ego` profile 是机器人的 Ego Harness，只能经 Ego API 感知与行动，shell、文件、网页等通用工具已禁用；`world` 与 `world-task` profile 是 World Harness，经世界控制接口构建资产、组合场景、控制 Episode。机器人与世界使用不同的 `DSH_HOME`。

控制台对话在 Windows 使用 `dsh.cmd`，在 macOS/Linux 使用 `dsh`，通过 UTF-8 传输提示词和运行事件。停止机器人对话会结束 Harness 进程树，并在请求停止机器人动作后交还控制权；动作停止请求失败时，控制台会显示错误。

机器人的 DeepSeek API-key 路由对暂时性模型故障进行退避重试，包括响应在 `message_stop` 前结束的 `STREAM_CLOSED`，每个模型步骤最多重试五次。已完成的工具调用保留，不完整的响应不会执行工具。重试耗尽后仍会明确报错。可在机器人 profile 的 `cordis.patch.yml` 中通过 `llm-deepseek.config.retryPolicy` 配置此策略。

浏览器刷新、客户端超时或取消可能中断本机 HTTP 响应。JSON、二进制和204响应遇到断管、连接重置或中止时结束当前连接，不再打印未处理的服务端 traceback。其他 I/O 故障和路由异常仍正常报告。响应断开既不会回滚也不会重试路由处理；重复命令前应先查询操作状态。

## 目录

| 路径 | 内容 |
|---|---|
| `src/steward/scene` | WS 与 ES 共用的 SceneState、校验器、MJCF 转换 |
| `src/steward/assets`、`authoring` | 资产生成、校验、预览、资产库；场景与 Scenario |
| `src/steward/world` | WSim 与 Steward 主机（WCA、机器人端口） |
| `src/steward/ego` | Ego Runtime：估计器、ESim、技能、Ego API |
| `src/steward/observer` | ES 与 World State 的对比评估 |
| `dsh/` | DeepSeek Harness 插件与 bundle（锁定 `@deepseek-ai/dsh@0.2.1-rc.3`） |
| `scripts/` | profile 创建、检查、多种子回归 |
| `compat/snapshots` | 组合配置快照 |

运行数据写入 `var/`，不纳入版本管理。

## 相机模式

机器人相机卡片默认使用单相机模式，按钮可切换为按左、原相机、右排列的三个同步画面。原有 `head_camera`、机器人 RGB/RGB-D 接口及感知输入保持不变。左右相机复制原相机的内参，分别横向偏移 0.12 米，并各向外偏转 25° 以扩大覆盖范围。`--camera-offset` 修改单侧距离（米）；`--camera-yaw` 设置向外偏转角，范围为 0°（平行）至 60°。新增相机不增加几何体、质量或碰撞。三视角使用同一份物理状态快照，在独立渲染线程中生成；单相机预览不渲染左右相机，机器人采集时按需渲染。切换失败会保留原模式，并在卡片中显示错误。

World Control API 提供 `GET/POST /wca/cameras`（robot、mode）及 `GET /wca/cameras/frame?robot=w:robot-1`（一幅或三幅 JPEG，包含共同仿真时间、像素内参 K 和以米为单位的 OpenCV 相机到世界变换）。这些位姿标明来自仿真真值，不通过机器人传感器端口暴露。三相机快照保留头部相机的原分辨率。

## 机器人三相机采集

可向机器人发送：“保持不动，采集当前时刻左、中、右三个相机的图像，报告共同时间戳和保存路径。”传感器工具 `ego_capture_cameras` 将三张 JPEG 和 `capture.json` 保存到机器人工作目录下的 `var/camera-captures`，支持控制台的两种相机显示模式。图像来自同一传感器时刻；标定包含像素内参 K 和以原始头部相机为参考、采用 OpenCV 轴向与米制单位的 `camera_to_reference`。数据通过机器人传感器端口与 Ego API 返回，不含仿真绝对位姿。Ego 提供者的 `cameraCaptureDir` 和 `cameraMaxBytes` 可配置保存目录及 RGB 图像总字节上限（默认 16 MiB）。通用场景准备工具（默认中间 RGB、显式目标视角）及提交工具见 [rgbd_video_gen 指南](dsh/packages/dsh-bundle-rgbd-video-gen/README.zh.md)。

工具 `ego_gripper_pose` 读取当前关节编码器和固定相机支架标定，无需拍摄图像或移动机器人。机器人侧正向运动学返回 `gripper_to_base`，以及每个相机对应的 `gripper_to_camera` 矩阵，平移单位均为米。这些矩阵将手爪 link 原点坐标系（x 向前、y 向左、z 向上）的点转换到底盘或所选 OpenCV 相机坐标系（x 向右、y 向下、z 向前）。这是手爪 link 坐标系，不是相机坐标系。`ego_capture_cameras` 还会保存与三张图像使用同一编码器时间戳的 `gripper_pose`；合成新视角时应使用该内嵌位姿，避免把机器人运动期间分别查询的数据混用。

Agent 可在运动前调用 `ego_rgb_recording_start`，让它按仿真时间 FPS（默认 2）记录中间相机 RGB，完成后用 `ego_rgb_recording_stop` 结束。模型响应速度不决定传感器采样节拍。`ego_rgb_recording_status` 报告保存帧数、时间戳与失败。这些工具不导航，agent 仍独立使用预测收据和运动工具。对于 NovelAnything，`novelanything_prepare_gripper_view` 利用测量里程计与固定标定，将完成的录制转换为本地场景/证据 ZIP 和当前手爪目标视角，`ego_camera_calibration` 无需拍摄即可提供 RGB 内参和固定相对变换，见 [NovelAnything 指南](dsh/packages/dsh-bundle-novelanything/README.zh.md)。

rgbd_video_gen 的运动证据应对完成的录制调用 `rgbd_video_gen_prepare_recording`，不要只准备最后一张相机快照。它在本地保留全部帧，并准确报告每个远端任务实际使用哪些时序帧；默认使用全部帧或均匀8帧的策略及显式覆盖方式见其指南。

## 远程 4D 重建

World 和机器人 Ego Harness 均提供 `slarm` skill 与 SLARM 工具，使用各自权限内的输入，不自动将预测合并到状态。两者可通过 SLARM 工具上传合规 ZIP、提交重建、查询进度、取消任务，并下载经过大小和 SHA256 校验的点云与视频。Windows 安装命令是 `.\scripts\setup-slarm.ps1`；安装后重启 Steward，在所选 Harness 对话中给出合规 ZIP 路径。机器人输入须位于自身工作空间内；单次相机快照不等于16帧时间序列。输入格式、示例提示词及存储位置见 [SLARM 使用说明](dsh/packages/dsh-bundle-slarm/README.zh.md)。

三相机模式下，**采集 16 帧** 按每秒 10 个仿真时刻记录 48 张图片，并显示进度、取消操作和完成后的 ZIP 路径。要执行完整流程，可向 World Harness 发送：“用 w:robot-1 的三相机按 10fps 采集 16 帧，调用 SLARM 重建并下载全部点云和两种视频。”仿真必须继续推进；采集不会指挥机器人移动。采集期间禁止切换相机模式。录制限制、坐标含义和失败恢复见 [SLARM 使用说明](dsh/packages/dsh-bundle-slarm/README.zh.md#use-this-package)。

## 新视角 RGB/深度生成

仅机器人 Ego Harness 提供 `rgbd-video-gen` skill，可调用 `rgbd_video_gen` 提交场景或服务端 demo、查询与取消任务，并下载经过校验的结果。在 Windows 运行 `.\scripts\setup-rgbd-video-gen.ps1`，然后重启机器人对话。输入格式、demo 用法和服务端配置见 [rgbd_video_gen 指南](dsh/packages/dsh-bundle-rgbd-video-gen/README.zh.md)。

机器人 Ego Harness 还提供 `novelanything`，用于仅以 RGB 输入的远程 NovelAnything 新视角合成。Windows 运行 `.\scripts\setup-novelanything.ps1` 后重启机器人聊天。仅使用中间 RGB `head_camera`，需要合规且带位姿的纯 RGB ZIP，不包含深度文件或 depth_path 字段；多个上下文须来自同一中间相机的不同时刻/位姿，排除左右相机。场景单位、任务恢复和输出路径见 [NovelAnything 指南](dsh/packages/dsh-bundle-novelanything/README.zh.md)。World profile 不安装它。

模型文件统一保存在 `var/dsh/<调用方>/workspace/` 内，调用方为 `world` 或 `robot-1`：`inputs/rgbd_video_gen/`、`inputs/novelanything/` 和 `inputs/slarm/` 保留提交输入；`outputs/rgbd_video_gen/<job_id>/`、`outputs/novelanything/<job_id>/` 和 `outputs/slarm/<reconstruction_id>/` 保留结果。每个结果目录包含 `manifest.json`，提供后续流程使用的本地绝对路径。这些输入和输出目录已被 Git 忽略。请求恢复记录位于该调用方工作空间的 `var/` 内；Steward 根目录不创建 `inputs/` 或 `outputs/` 文件夹。
