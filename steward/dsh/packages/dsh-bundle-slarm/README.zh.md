---
description: "Steward 的 SLARM 配置层：上传 Waymo ZIP，获取远程 4D 重建结果。"
kind: "package-bundle"
---

# @steward/dsh-bundle-slarm

[English](README.md) | 中文

## 摘要

为 World Harness 添加远程 4D 重建能力。该配置层提供上传、进度查询、取消和经校验的产物下载。安装到世界 profile 后，向智能体提供本地 Waymo ZIP；重建模型在配置的服务器上运行。

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

在 Steward 目录中准备好 DSH 依赖后，执行以下 Windows 安装命令。脚本编译本地插件，将 bundle 加入 `var/dsh/world` 下的 `world` 和 `world-task`，保留已有 profile 设置。

```powershell

.\scripts\setup-slarm.ps1

```

macOS/Linux 的[完整 profile 安装脚本](../../../scripts/setup-dsh-profiles.sh)也会安装该层。更新世界对话指令后，用 `run_windows.bat` 重启 Steward，打开控制台并选择**世界 · World Harness**。

将合规 ZIP 放到 `var/input/scene.zip`，然后发送：

> 请使用 var/input/scene.zip 重建第 0 到 15 帧，输出 pointcloud、rgb_video 和 diagnostic_video。跟踪校验和进度直到结束，下载全部点云和两种视频，报告真实输入图片数、输出视角数和已校验的本地路径。

合规压缩包包含预处理后的 Waymo 三相机图像、标定、已知位姿及时间戳。重建接受 16–256 个时间帧；`[0,16)` 表示第 0 到 15 帧。仅装入普通视频的 ZIP 不符合该输入格式。

恢复时提供已返回的 `dataset_id` 或 `reconstruction_id`。停止远程任务时，明确提出“取消重建任务 rec_…，并确认最终状态”。停止对话只会停止本地等待。

通过[客户端配置](../dsh-slarm-client/README.zh.md#use-this-package)修改服务器和目录。默认服务器为 `http://115.120.57.9/slarm`，输入根目录为 `.`，状态目录为 `var/slarm`，均相对于 DSH 启动目录解析。应从 Steward 目录启动，或配置绝对目录。


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

本集成支持 `waymo_slarm_v1` 和结果 schema `1.0`，已通过 API 0.4.0 的兼容 Waymo 接口实测。不负责普通视频转换、跨窗口场景融合或将预测结果导入 MuJoCo。


-----

<a id="dev-note"></a>
## 开发备注

无。
