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

Windows 完成本地依赖安装和 profile 创建后，可双击 `run_windows.bat` 启动世界与机器人服务；该文件配置本地 Python 依赖路径，并让机器人子进程使用基础 Python 解释器。

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

机器人相机卡片默认使用单相机模式，按钮可切换为按左、原相机、右排列的三个同步画面。原有 `head_camera`、机器人 RGB/RGB-D 接口及感知输入保持不变。左右相机复制原相机的内参和朝向，分别横向偏移 0.12 米；通过 `steward up --camera-offset 0.15` 可修改单侧距离。新增相机不增加几何体、质量或碰撞。三视角使用同一份物理状态快照，在独立渲染线程中生成；单相机模式不渲染左右相机。切换失败会保留原模式，并在卡片中显示错误。

World Control API 提供 `GET/POST /wca/cameras`（robot、mode）及 `GET /wca/cameras/frame?robot=w:robot-1`（一幅或三幅 JPEG，包含共同仿真时间、像素内参 K 和以米为单位的 OpenCV 相机到世界变换）。这些位姿标明来自仿真真值，不通过机器人传感器端口暴露。三相机快照保留头部相机的原分辨率。

## 远程 4D 重建

World Harness 可通过 SLARM 工具上传合规 Waymo ZIP、提交重建、查询进度、取消任务，并下载经过大小和 SHA256 校验的点云与视频。Windows 安装命令是 `.\scripts\setup-slarm.ps1`；安装后重启 Steward，在“世界 · World Harness”对话中给出 ZIP 路径。输入格式、示例提示词及存储位置见 [SLARM 使用说明](dsh/packages/dsh-bundle-slarm/README.zh.md)。
