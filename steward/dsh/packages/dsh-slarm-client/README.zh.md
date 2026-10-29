---
description: "SLARM 重建 HTTP 提供者的配置、持久化提交标识与校验下载存储。"
kind: "package-reference"
---

# @steward/dsh-slarm-client

[English](README.md) | 中文

## 摘要

将本地 Waymo ZIP 上传到 SLARM 服务器并获取重建结果。稳定请求键用于恢复响应丢失的提交。下载以流式方式写入磁盘，通过大小和 SHA256 校验后才成为完整文件。

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

通过 [bundle](../dsh-bundle-slarm/README.zh.md) 安装。使用 DSH profile patch 修改其中的 `steward-slarm-api` 行；该提供者不读取或转发 `DEEPSEEK_API_KEY`。

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | 必填 | HTTP(S) API 基地址，部署包含 `/slarm` 时需保留 |
| `inputRoot` | 必填 | 允许上传的 ZIP 所在的已有目录 |
| `stateDir` | 必填 | 本地请求记录、清单和下载文件目录 |
| `requestTimeoutMs` / `uploadTimeoutMs` / `downloadTimeoutMs` | 15000 / 1800000 / 300000 | 每次尝试的超时 |
| `pollIntervalMs` / `maxWaitSeconds` | 2000 / 20 | 轮询间隔和请求等待上限 |
| `retryCount` / `retryDelayMs` / `maxRetryDelayMs` | 2 / 1000 / 30000 | 额外 HTTP 尝试次数、初始退避及可接受的等待上限 |
| `maxMetadataBytes` | 2097152 | JSON 响应大小上限 |
| `maxUploadBytes` / `maxArtifactBytes` | 各 2147483648 | 本地单个压缩包和单个产物的大小上限 |

相对目录基于启动目录解析。ZIP 路径限制在 `inputRoot` 内，并解析符号链接；同时受服务器上传限制约束。当前 HTTP 请求及有限重试结束前，实际等待时间可能超过请求的等待时长。

提交结果不确定时，使用相同的 `request_key` 和选项重试。本地存储在 POST 前保留幂等键，拒绝将同一标识用于不同内容。重启后应保留该存储；新键代表新任务。

每个服务端地址使用 SHA256 前缀命名的独立目录。`results/<reconstruction_id>/result.json` 保存完整清单；`<artifact_id>/<filename>` 保存经校验的下载文件。回执记录路径、大小和哈希。再次下载会复用已校验的完整文件；不完整下载从头重试。

HTTP 失败会停止依赖该请求的后续工作。永久错误不重试；符合条件的临时错误使用有限退避并遵守 `Retry-After`。若延迟超过配置上限，则报告错误而不会提前重试。远程结果过期不会删除已下载的本地文件。


-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节</summary>

[src/index.ts](src/index.ts) 负责请求、轮询和下载；[src/protocol.ts](src/protocol.ts) 校验 HTTP 元数据；[src/storage.ts](src/storage.ts) 原子发布本地记录。卸载会中止本地操作并等待清理，已被接受的远程任务会继续运行，可使用同一本地存储恢复。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[Steward](../../../README.zh.md) · [服务类型](../dsh-slarm/README.zh.md) · [HTTP 提供者](../dsh-slarm-client/README.zh.md) · [工具](../dsh-tool-slarm/README.zh.md) · [Bundle](../dsh-bundle-slarm/README.zh.md)


-----

<a id="model-experience"></a>
## 模型体验

间接影响：[工具](../dsh-tool-slarm/README.zh.md) 返回大小受限的 JSON 结果，完整结果清单保存在磁盘上。


-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

取消操作要求提交曾在此存储中创建或恢复。产物传输不支持 HTTP Range 断点续传或自动下载重试。客户端不解压 ZIP，也不解释 NPZ 数组。


-----

<a id="dev-note"></a>
## 开发备注

无。
