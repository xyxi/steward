---
description: "Steward 的 SLARM 配置层：上传 Waymo ZIP，获取远程 4D 重建结果。"
kind: "package-bundle"
---

# @steward/dsh-bundle-slarm

[English](README.md) | 中文

## 摘要

通过 `slarm` skill 为 World 和机器人 Ego Harness 添加远程场景4D重建能力。该配置层提供上传、进度查询、取消和经校验的产物下载。安装到调用方 profile 后，向智能体提供合规三相机时间序列 ZIP；重建模型在配置的服务器上运行。

## 目录

- [使用方式](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方式

在 Steward 目录中准备好 DSH 依赖后，执行以下 Windows 安装命令。脚本编译本地插件，将工具和 skill 加入 `var/dsh/world` 下的 `world`、`world-task` 及 `var/dsh/robot-1` 下的 `ego`，保留已有 profile 设置。

```powershell

.\scripts\setup-slarm.ps1

```

macOS/Linux 的[完整 profile 安装脚本](../../../scripts/setup-dsh-profiles.sh)也会安装该层。更新世界对话指令后，用 `run_windows.bat` 重启 Steward，打开控制台并选择 World 或机器人 Harness。

将合规 ZIP 放到 `var/input/scene.zip`，然后发送：

> 请使用 var/input/scene.zip 重建第 0 到 15 帧，输出 pointcloud、rgb_video 和 diagnostic_video。跟踪校验和进度直到结束，下载全部点云和两种视频，报告真实输入图片数、输出视角数和已校验的本地路径。

合规压缩包包含预处理后的 Waymo 三相机图像、标定、已知位姿及时间戳。重建接受 16–256 个时间帧；`[0,16)` 表示第 0 到 15 帧。仅装入普通视频的 ZIP 不符合该输入格式。

机器人必须使用自身观测序列与已知或估计位姿，或工作空间内提供的合规 ZIP。单时刻 `ego_capture_cameras` 工具不提供 SLARM 所需的16–256个时间帧。机器人不得调用特权 World 采集或读取仿真文件。

对于运行中的仿真，先用 `world_cameras` 选择 `triple`，用 `world_capture` 开始采集，再用 `world_capture_status` 等待 `succeeded`。将返回的 `archive_path` 交给 `slarm_upload`，显式设置 `format: "slarm_scene_v1"`，之后沿用验证、重建和下载步骤。`world_capture_cancel` 请求取消本地采集；只有 `cancelled` 才确认清理完成。停止对话只停止等待，已接受的采集继续运行。启动响应丢失时，先用 `world_cameras` 查询最近的采集，再决定是否重新开始。

采集接受 16–256 个同步时刻、1–30 fps，采样周期必须是物理步长的整数倍（默认步长支持 10 fps）。有界队列复制仿真状态；图像渲染和 ZIP 打包在独立线程中执行。队列溢出、场景替换和 120 秒实际时间超时会明确失败。需要静止采集时，应单独停止机器人运动；暂停仿真会阻止采集推进。每台主机同时只允许一个采集任务，相机切换按钮在清理完成前保持锁定。

ZIP 包含 `scene.json`，每个时刻有三张 PNG，对应 `camera_0_left`、`camera_1_center`、`camera_2_right`。标定使用原始图像像素；位姿采用 OpenCV 轴（右、下、前）、米和相机到世界矩阵。原相机作为参考相机。位姿是**仿真真值**，不是 SLAM 估计。数据集时间从零开始，间隔为 `1/fps`；元数据保留仿真原始开始时间。结果坐标采用请求起始时刻参考相机的 FLU 系（前、左、上）；对齐世界时使用结果的 `coordinates.T_world_scene`，重建子区间时尤其如此。预测不会自动合并到 World State 或 Ego State。

导出保存在 `<Steward root>/captures/<capture_id>/scene.zip`（通常是 `var/steward/captures/`）。只有成功采集才返回压缩包路径；部分图像可能保留以便诊断。采集句柄仅在当前进程有效，重启后失效，但已完成 ZIP 可继续使用。WCA 路由为 `POST /wca/capture`（`robot`、`frames`、`fps`）、`GET /wca/capture?capture_id=…&wait_seconds=…`（0–20 秒）和 `POST /wca/capture/cancel`（`capture_id`）。机器人传感器端口不提供这些特权接口。

恢复时提供已返回的 `dataset_id` 或 `reconstruction_id`。停止远程任务时，明确提出“取消重建任务 rec_…，并确认最终状态”。停止对话只会停止本地等待。

通过[客户端配置](../dsh-slarm-client/README.zh.md#use-this-package)修改服务器和目录。bundle 要求设置调用方的 `DSH_HOME`，Steward 与安装脚本会设置该值。输入、输出与恢复记录分别保存在 `DSH_HOME/workspace/inputs/slarm`、`DSH_HOME/workspace/outputs/slarm` 和 `DSH_HOME/workspace/var/slarm`，不受启动目录影响。默认端点为 `http://115.120.57.9/slarm`。输入路径仍相对于启动目录校验：World 可提交采集 ZIP；机器人输入路径必须位于机器人工作空间内。


-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

[cordis.patch.yml](cordis.patch.yml) 添加 `steward-slarm-api` 和 `steward-tool-slarm`，组合 HTTP 提供者与工具，无需修改 DSH 智能体循环。机器人 profile 不包含此 bundle。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[Steward](../../../README.zh.md) · [服务类型](../dsh-slarm/README.zh.md) · [HTTP 提供者](../dsh-slarm-client/README.zh.md) · [工具](../dsh-tool-slarm/README.zh.md) · [Bundle](../dsh-bundle-slarm/README.zh.md)


-----

<a id="model-experience"></a>
## 模型体验

间接影响：模型指令与 JSON 结果由[工具包](../dsh-tool-slarm/README.zh.md)定义。


-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

本集成支持 API 0.4.0 的 `waymo_slarm_v1`、`slarm_scene_v1` 和结果 schema `1.0`。不负责普通视频转换、相机位姿估计、跨窗口场景融合或将预测结果导入 MuJoCo。相同内参和同步图片不代表重建精度已得到验证；视野重叠、基线和模型训练领域仍会影响结果。


-----

<a id="dev-note"></a>
## 开发备注

无。
