"""Additive robot camera rig and WCA-only synchronized RGB rendering.

The original head camera and robot sensor routes retain their identities. Side cameras add no
geometry or mass. A single worker owns the private model and all its OpenGL resources; every
batch uses one physics snapshot. Calibration is simulator truth, never an Ego sensor reading.
"""

from __future__ import annotations

import base64
import copy
import math
import threading
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import mujoco
import numpy as np

from steward.glrender import close_renderer, encode_image
from steward.math3d import matrix_from_quat
from steward.net import HttpError

CAMERA_IDS = ("head_camera_left", "head_camera", "head_camera_right")


def add_camera_rig(build, offset_m: float) -> None:
    """Add cameras offset left/right from each original head camera in generated MJCF only."""
    if not math.isfinite(offset_m) or not 0 < offset_m <= 0.5:
        raise ValueError("camera offset must be in (0, 0.5] metres")
    root = ET.fromstring(build.xml)
    for robot, names in build.names.items():
        original = names.cameras.get("head_camera")
        if original is None:
            continue
        for body in root.iter("body"):
            camera = next((c for c in body.findall("camera") if c.get("name") == original), None)
            if camera is None:
                continue
            position = np.fromstring(camera.get("pos"), sep=" ")
            right = matrix_from_quat(np.fromstring(camera.get("quat"), sep=" "))[:, 0]
            for sensor_id, sign in ((CAMERA_IDS[0], -1), (CAMERA_IDS[2], 1)):
                if sensor_id in names.cameras:
                    raise ValueError(f"reserved camera id already exists: {sensor_id}")
                side = copy.deepcopy(camera)
                side.set("name", f"{robot}::{sensor_id}")
                side.set("pos", " ".join(str(v) for v in position + sign * offset_m * right))
                body.append(side)
                names.cameras[sensor_id] = side.get("name")
            break
    build.xml = ET.tostring(root, encoding="unicode")


class CameraRenderer:
    """One-thread renderer; callers must serialize render/close on the owning GL thread."""

    def __init__(self):
        self.source = self.model = self.data = None
        self.renderers = {}

    def render(self, sim, robot: str, ids: tuple[str, ...]) -> dict:
        """Render RGB and OpenCV calibration from one locked simulation snapshot."""
        with sim.lock:
            if self.source is not sim.model:
                self.close()
                self.source = sim.model
                self.model = copy.deepcopy(sim.model)
                self.data = mujoco.MjData(self.model)
            mujoco.mj_copyData(self.data, self.model, sim.data)
            _, sensor = sim.camera_pose(robot)
            intrinsics = dict(sensor["intrinsics"])
            epoch = sim._epoch
        return self.render_data(robot, ids, intrinsics, epoch)

    def render_data(self, robot: str, ids: tuple[str, ...], intrinsics: dict, epoch: int) -> dict:
        """Render the installed private data, with all views sharing its exact simulation time."""
        mujoco.mj_forward(self.model, self.data)
        width, height = intrinsics["width"], intrinsics["height"]
        focal = height / (2 * math.tan(math.radians(intrinsics["fovy"]) / 2))
        calibration = [[focal, 0, (width - 1) / 2], [0, focal, (height - 1) / 2], [0, 0, 1]]
        key = (width, height)
        if key not in self.renderers:
            self.renderers[key] = mujoco.Renderer(self.model, height, width)
        renderer = self.renderers[key]
        views = {}
        for camera in ids:
            name = f"{robot}::{camera}"
            cid = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_CAMERA, name)
            if cid < 0:
                raise ValueError(f"camera is unavailable: {name}")
            transform = np.eye(4)
            transform[:3, :3] = self.data.cam_xmat[cid].reshape(3, 3) @ np.diag([1, -1, -1])
            transform[:3, 3] = self.data.cam_xpos[cid]
            renderer.update_scene(self.data, camera=name)
            views[camera] = {"width": width, "height": height, "K": calibration,
                             "camera_to_world": transform.tolist(), "rgb": renderer.render().copy()}
        return {"robot": robot, "stamp": float(self.data.time), "epoch": epoch,
                "pose_source": "simulation_ground_truth", "camera_axes": "opencv_x_right_y_down_z_forward",
                "reference_camera": "head_camera", "views": views}

    def close(self) -> None:
        for renderer in self.renderers.values():
            close_renderer(renderer)
        self.renderers.clear()
        self.source = self.model = self.data = None


class CameraPipeline:
    """Per-host camera modes; switching validates a full frame before publishing the new mode."""

    def __init__(self, sim):
        self._sim = sim
        self._lock = threading.RLock()
        self._slots = threading.BoundedSemaphore(2)
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="camera-rig")
        self._renderer = CameraRenderer()
        self._modes: dict[str, str] = {}
        self._revision = 0
        self._closed = False
        self._capture_robot: str | None = None

    def state(self, robot: str) -> dict:
        with self._lock:
            return {"robot": robot, "mode": self._modes.get(robot, "single"), "revision": self._revision,
                    "capture_active": self._capture_robot == robot}

    def _frame(self, robot: str, ids: tuple[str, ...]) -> dict:
        if not self._slots.acquire(blocking=False):
            raise HttpError(503, "相机渲染繁忙，请稍后重试")
        try:
            return self._worker.submit(self._renderer.render, self._sim(), robot, ids).result()
        finally:
            self._slots.release()

    def set_mode(self, robot: str, mode: str) -> dict:
        if mode not in ("single", "triple"):
            raise HttpError(400, "相机模式必须是 single 或 triple")
        with self._lock:
            if self._closed:
                raise HttpError(503, "相机服务已关闭")
            sim = self._sim()
            with sim.lock:
                sim.camera_pose(robot)
            if self._capture_robot == robot:
                raise HttpError(409, "采集进行中，请完成或取消后再切换相机模式")
            if mode == "triple":
                self._frame(robot, CAMERA_IDS)
            self._modes[robot] = mode
            self._revision += 1
            return self.state(robot)

    def preview(self, robot: str) -> dict:
        with self._lock:
            if self._closed:
                raise HttpError(503, "相机服务已关闭")
            state = self.state(robot)
            ids = CAMERA_IDS if state["mode"] == "triple" else ("head_camera",)
            result = self._frame(robot, ids)
        for view in result["views"].values():
            view["image"] = "data:image/jpeg;base64," + base64.b64encode(encode_image(view.pop("rgb"), "jpeg")).decode("ascii")
        return {**result, **state}

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._worker.submit(self._renderer.close).result()
            self._worker.shutdown(wait=True)

    def reserve_capture(self, robot: str) -> None:
        """Freeze camera mode until the recording owner releases its reservation."""
        with self._lock:
            if self._closed:
                raise HttpError(503, "相机服务已关闭")
            if self._capture_robot is not None:
                raise HttpError(409, "已有相机采集任务，请等待完成或取消")
            if self._modes.get(robot, "single") != "triple":
                raise HttpError(409, "请先切换到三相机模式")
            self._capture_robot = robot

    def release_capture(self, robot: str) -> None:
        """Release the matching recording's mode reservation after all local work settles."""
        with self._lock:
            if self._capture_robot == robot:
                self._capture_robot = None
