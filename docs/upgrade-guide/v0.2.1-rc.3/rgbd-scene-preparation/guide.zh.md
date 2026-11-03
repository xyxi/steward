---
kind: upgrade-guide
description: "rgbd_video_gen 以显式目标和默认中间 RGB 证据的通用准备工具替代仅支持手爪视角的准备工具。"
---

# 通用 RGBD 场景准备

[English](guide.md) | 中文

## 变更

`rgbd_video_gen_prepare_scene` 替代 `rgbd_video_gen_prepare_gripper_view`。服务方法由 `prepareGripperView` 改为 `prepareScene(captureManifest, options, signal)`。准备操作默认使用一张中间 `head_camera` RGB，不再默认使用三个证据相机。目标视角必须显式指定，不隐式选择手爪目标。已有下载结果仍然有效。

## 迁移

1. 替换工具或服务方法名称，提供包含1–24项的 `targets`。每项指定 `frame`（`reference` 表示采集时中间 OpenCV 相机帧，`gripper` 表示同步手爪的前、左、上坐标轴），以及刚体 OpenCV `camera_to_frame` 矩阵或完整的 `position`、`look_at`、`up` 三个向量。位置单位为米，不混用两种形式。
2. 原手爪前视目标传入 `targets:[{frame:"gripper",position:[0,0,0],look_at:[1,0,0],up:[0,0,1]}]`。手爪目标要求同一时间戳的内嵌位姿；参考帧目标不要求手爪位姿。
3. 省略 `source_cameras` 时只使用中间 RGB。保留三相机证据须显式传入 `["head_camera_left","head_camera","head_camera_right"]`。只读取选中的 JPEG；所选相机必须与中间相机共享分辨率和内参。
4. 提交返回的 `scene_path` 时，使用工具返回的准确 `num_source_views` 和 `max_target_views`。单证据、单目标产生2帧，必须设置 `num_source_views=1`；远端提交默认值仍为6。场景文件以 `scene-<hash>.json` 命名，位于准备输入目录中。确认默认场景元数据只列出 `head_camera`。
5. 运动证据须围绕独立控制的导航开始和结束 RGB 录制，再将成功句柄及显式目标传给 `rgbd_video_gen_prepare_recording`。Provider 要求机器人 Ego 服务和 Python `/ego/rgb/record/export` 接口，须编译插件并重启 Steward/机器人聊天以加载两端变更。重启前保存所需的实时录制证据。不超过8帧的录制默认全部使用，超过时默认均匀选取包含首尾的8帧；显式数量或批次索引可覆盖默认值；检查准备结果的源帧索引和 all_frames_used，不能把本地保留数量当成模型输入数量。
