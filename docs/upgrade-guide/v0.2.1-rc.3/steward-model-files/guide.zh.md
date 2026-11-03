---
kind: upgrade-guide
description: "Steward 模型下载使用工作空间输出目录，并将提交输入与请求恢复状态分别保存。"
---

# Steward 模型输入与输出目录

[English](guide.md) | 中文

## 变更

Steward SLARM 和 rgbd_video_gen 客户端将结果保存到调用方 `DSH_HOME/workspace/`（`var/dsh/world/workspace` 或 `var/dsh/robot-1/workspace`）下的 `outputs/slarm/<reconstruction_id>/` 与 `outputs/rgbd_video_gen/<job_id>/`，替代 `stateDir` 下按端点哈希隔离的目录。RGBD 工件直接位于任务目录内。SLARM 保留工件 ID 子目录，避免同名文件冲突。两个工具返回 `local_manifest_path`，对应本地 `manifest.json`，其中包含已校验文件路径与输入引用。

提交会将 JSON 场景与参数或上传 ZIP 归档到对应的 `inputs/<model>/` 目录。手爪视角准备默认写入 `inputs/rgbd_video_gen/prepared/`。服务器 demo 保留选择信息，不包含服务器持有的证据图像。缺少本地输入记录的历史提交，其输入引用为 null。已有旧文件不会被删除或自动移动。

## 迁移

1. 重启 Steward 加载客户端变更。将旧 World `var/slarm` 恢复记录迁移到 `var/dsh/world/workspace/var/slarm`，保留幂等键并更新本地路径引用；机器人恢复记录已位于自身工作空间内。SLARM bundle 从 `DSH_HOME` 派生三个存储目录；World 和机器人 profile 均安装其 skill。在模型客户端 profile 条目中设置 `inputsDir` 和 `outputsDir` 可覆盖默认值；相对路径从 `inputRoot` 解析。任务 ID 可能冲突的不同端点需要分别配置输出目录。
2. 后续流程改用工具返回的 `local_manifest_path`，不再拼接路径。读取 `files` 获取已校验下载；读取 RGBD `targets` 获取目标相机、RGB 与深度数组的对应关系。路径为 null 表示尚未下载该文件。
3. 查询并下载已有成功任务，将其发布到新目录；或复制历史文件，并在使用前按服务器结果进行校验。在后续流程使用新清单之前，保留已有文件。新提交会在 POST 前保留输入。
4. 确认已下载任务在 `outputs/<model>/` 下包含 `result.json`、`manifest.json` 和已校验文件。将旧 Steward 根目录的 `inputs/slarm` 和 `outputs/slarm` 迁移到 World 工作空间，并更新清单路径，然后删除空的根目录文件夹。现有 `var/` Git 忽略规则覆盖所有调用方文件。
