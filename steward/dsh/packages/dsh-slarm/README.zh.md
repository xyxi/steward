---
description: "供提供者和工具消费者使用的 SLARM 服务类型、操作标识及错误。"
kind: "package-library"
---

# @steward/dsh-slarm

[English](README.md) | 中文

## 摘要

通过 `ctx.slarm` 实现或调用 SLARM 提供者。服务将远程操作与工具呈现分离。带品牌类型的数据集、重建和产物标识用于区分各类 ID。

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

从 `@steward/dsh-slarm` 导入服务与请求类型。[src/index.ts](src/index.ts) 定义各操作、取消语义及结构化错误。应用通过 [bundle](../dsh-bundle-slarm/README.zh.md) 安装；该库本身不提供 profile 配置层。


-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

`SlarmService` 注册服务名 `slarm`。请求携带已解析的显式选项和稳定操作键。JSON 值保留 null；`SlarmError` 携带错误码、是否可重试、HTTP 状态与详情。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[Steward](../../../README.zh.md) · [服务类型](../dsh-slarm/README.zh.md) · [HTTP 提供者](../dsh-slarm-client/README.zh.md) · [工具](../dsh-tool-slarm/README.zh.md) · [Bundle](../dsh-bundle-slarm/README.zh.md)


-----

<a id="model-experience"></a>
## 模型体验

间接影响：消费者选择哪些服务结果进入对话；该库不发送模型请求。


-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

调用方的中止信号会停止本地 I/O，不代表服务器拒绝提交或取消了任务。应使用已返回的操作标识恢复查询或显式取消。


-----

<a id="dev-note"></a>
## 开发备注

无。
