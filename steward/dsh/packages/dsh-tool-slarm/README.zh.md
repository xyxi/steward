---
description: "面向智能体的 SLARM 上传、重建、状态查询、取消和下载行为。"
kind: "package-reference"
---

# @steward/dsh-tool-slarm

[English](README.md) | 中文

## 摘要

让 World Harness 重建合规 ZIP 并报告经校验的结果。工具区分提交已接受、重建终态和本地下载成功，保留模型输入数量与警告，避免将完成等同于精度验证。

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

安装 [bundle](../dsh-bundle-slarm/README.zh.md) 后使用世界对话。DSH 的标准工具面板显示各命名调用及 JSON 结果；二进制产物保留为本地文件。

智能体先读取 `slarm_capabilities`，通过 `slarm_upload` 上传，并用 `slarm_dataset_status` 查询至 ready。随后通过 `slarm_reconstruct` 提交，用 `slarm_status` 跟踪，并在成功后读取 `slarm_result`。`slarm_download` 接受该结果中的产物 ID；`slarm_cancel` 显式请求远程取消。准确参数与说明见 [src/index.ts](src/index.ts)。

上传和重建要求稳定的 `request_key`。轮询等待默认是零；`evaluate` 默认 false。必须显式选择输出类型。重建跨越多个窗口时，下载应包括全部 pointcloud 产物 ID。

`slarm_upload.format` 默认是 `waymo_slarm_v1`；上传成功的 `world_capture` 导出时选择 `slarm_scene_v1`。采集工具和坐标约定见 [bundle 说明](../dsh-bundle-slarm/README.zh.md#use-this-package)。

只有经过校验的结果返回 `completed: true`，才可报告重建完成。只有经校验的下载回执才表示本地文件就绪。`cancelling` 表示处理中，`cancelled` 状态才表示取消完成。结果过期或传输失败须与重建成功分别报告。


-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

工具通过插件 effect 注册，携带当前轮次的取消信号调用注入的 `slarm` 服务。标准 DSH 工具流程记录 JSON 输出，不引入自定义智能体循环或仅存在于浏览器的结果状态。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[Steward](../../../README.zh.md) · [服务类型](../dsh-slarm/README.zh.md) · [HTTP 提供者](../dsh-slarm-client/README.zh.md) · [工具](../dsh-tool-slarm/README.zh.md) · [Bundle](../dsh-bundle-slarm/README.zh.md)


-----

<a id="model-experience"></a>
## 模型体验

工具说明区分帧采样、终态和产物选择。结果包括实际模型调用次数、不同输入图片数、输入图片出现次数及输出视角数。空指标保留 null。几何、语义和运动均为预测；点数不是对象数，`quality_status=ok` 不能证明精度。工具 schema 保持稳定；各任务 JSON 会增长对话历史，并可能影响后续提示词缓存复用。


-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

不提供实例跟踪、对象分割结论、融合世界场景或自动机器人动作。停止轮次不请求远程取消。下载结果是文件引用，不是内嵌三维查看器。


-----

<a id="dev-note"></a>
## 开发备注

无。
