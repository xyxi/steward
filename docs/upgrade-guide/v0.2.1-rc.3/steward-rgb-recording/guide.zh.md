---
kind: upgrade-guide
description: "Steward 移除新增深度相机，NovelAnything 改用纯 RGB 录制输入。"
---

# Steward 纯 RGB 录制与 NovelAnything 输入

[English](guide.md) | 中文

## 变更

Steward 移除独立的 `head_depth_camera`、`--depth-camera-extrinsics` 选项以及相机采集/标定响应中的深度字段。NovelAnything 的机器人输入仅使用中间 `head_camera` 的 RGB、位姿和内参，准备的 ZIP 不包含深度文件及 `depth_path`。模型仍预测目标 RGB 和深度。原有 `/sensors/rgbd` 感知流继续使用原始头部相机。

## 迁移

1. 从启动命令移除 `--depth-camera-extrinsics`。在仓库根目录运行 `pnpm --dir steward/dsh run build` 重新编译 Steward 插件，然后重启 Steward 与机器人聊天以加载 Python 和插件变更。重启将丢失实时录制句柄，请先保留所需的本地归档。
2. 将 `ego_rgbd_recording_start/status/stop` 替换为 `ego_rgb_recording_start/status/stop`。HTTP 录制路由从 `/sensors/rgbd/record/*` 和 `/ego/rgbd/record/*` 改为 `/sensors/rgb/record/*` 和 `/ego/rgb/record/*`；准备路由改为 `/ego/rgb/prepare-novelanything`。新句柄以 `rgb_` 开头。
3. 对成功的 RGB 录制调用 `novelanything_prepare_gripper_view`，上传其返回的 ZIP。确认 `metadata.input_modalities` 等于 `["rgb"]`，且归档不包含 `depth_path` 或深度图。远程部署须支持纯 RGB 输入（API 1.3.0 或更新）；不要添加深度来绕过旧服务限制。
