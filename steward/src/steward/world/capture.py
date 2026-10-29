"""Bounded simulation-clock recording and atomic SLARM scene ZIP export.

Physics only copies states at exact sampling steps. One recording thread owns rendering, PNG
encoding and packaging. Queue overflow, model replacement and timeout fail the recording;
neither missing frames nor timestamps are silently repaired. A completed ZIP survives restart.
"""
from __future__ import annotations

import copy
import json
import math
import queue
import threading
import time
import uuid
import zipfile
from pathlib import Path

import mujoco
import numpy as np

from steward.glrender import encode_image
from steward.net import HttpError
from steward.world.cameras import CAMERA_IDS, CameraRenderer

EXPORT_IDS = ("camera_0_left", "camera_1_center", "camera_2_right")
TERMINAL = ("succeeded", "failed", "cancelled")


class CaptureJob:
    """One recording, with cancellation confirmed only after its renderer and hook are closed."""

    def __init__(self, sim, robot, frames, fps, root, release, *, capacity=4, timeout_s=120):
        self.id = "cap_" + uuid.uuid4().hex
        self.sim, self.robot, self.frames, self.fps = sim, robot, frames, fps
        self.directory = root / self.id
        self.directory.mkdir(parents=True)
        self.lock = threading.RLock()
        self.queue = queue.Queue(maxsize=capacity)
        self.stop = threading.Event()
        self.done = threading.Event()
        self.state, self.error = "capturing", None
        self.captured = self.written = 0
        self.archive = None
        self.release = release
        self.deadline = time.monotonic() + timeout_s
        with sim.lock:
            self.source = sim.model
            self.model = copy.deepcopy(sim.model)
            self.epoch = sim._epoch
            self.first_step = sim.step_count
            self.origin_time = sim.time
            self.stride = round(1 / (fps * sim.timestep))
            _, sensor = sim.camera_pose(robot)
            self.intrinsics = dict(sensor["intrinsics"])
            self.unsubscribe = sim.subscribe_steps(self.sample)
            self.sample()
        self.thread = threading.Thread(target=self.run, name=f"capture-{self.id}", daemon=True)
        try:
            self.thread.start()
        except RuntimeError:
            self.unsubscribe()
            raise

    def fail(self, message):
        with self.lock:
            if self.state not in TERMINAL and self.error is None:
                self.error = message
            self.stop.set()

    def sample(self):
        """Nonblocking callback under the physics lock; queue saturation fails visibly."""
        try:
            with self.lock:
                if self.stop.is_set() or self.captured == self.frames:
                    return
                if self.sim.model is not self.source or self.sim._epoch != self.epoch:
                    self.fail("场景已重置或模型已改变，请重新采集")
                    return
                expected = self.first_step + self.captured * self.stride
                if self.sim.step_count < expected:
                    return
                if self.sim.step_count != expected:
                    self.fail("仿真采样时间不连续，请重新采集")
                    return
                data = mujoco.MjData(self.model)
                mujoco.mj_copyData(data, self.model, self.sim.data)
                self.queue.put_nowait((self.captured, data))
                self.captured += 1
                if self.captured == self.frames:
                    self.state = "finalizing"
        except queue.Full:
            self.fail("渲染队列已满，采集未完成；请降低仿真倍速或采样帧率后重试")
        except Exception as exc:  # callback failure belongs to this recording, never the physics loop
            self.fail(f"采集状态快照失败：{exc}")

    def status(self):
        with self.lock:
            return {"capture_id": self.id, "status": self.state, "robot": self.robot,
                    "frame_count": self.frames, "fps": self.fps, "captured_frames": self.captured,
                    "written_frames": self.written, "error": self.error, "archive_path": self.archive,
                    "format": "slarm_scene_v1", "pose_source": "simulation_ground_truth",
                    "origin_sim_time": self.origin_time, "cancelled": self.state == "cancelled"}

    def cancel(self):
        with self.lock:
            if self.state not in TERMINAL:
                self.state = "cancelling"
                self.stop.set()
        return self.status()

    def run(self):
        renderer = CameraRenderer()
        renderer.source = renderer.model = self.model
        partial = self.directory / "scene.zip.part"
        scene = {"format": "slarm_scene_v1", "scene_id": self.id, "fps": self.fps,
                 "reference_camera": EXPORT_IDS[1], "cameras": {}, "frames": [],
                 "metadata": {"robot": self.robot, "pose_source": "simulation_ground_truth",
                              "origin_sim_time": self.origin_time,
                              "source_camera_ids": dict(zip(EXPORT_IDS, CAMERA_IDS))}}
        prepared = False
        try:
            (self.directory / "images").mkdir()
            while len(scene["frames"]) < self.frames:
                if self.stop.is_set():
                    return
                if time.monotonic() >= self.deadline:
                    self.fail("采集超时，请确认仿真未暂停，并重新采集")
                    return
                try:
                    index, renderer.data = self.queue.get(timeout=0.1)
                except queue.Empty:
                    continue  # waiting for a physics sample; deadline and cancellation remain active
                batch = renderer.render_data(self.robot, CAMERA_IDS, self.intrinsics, self.epoch)
                expected_time = self.origin_time + index / self.fps
                if abs(batch["stamp"] - expected_time) > 1e-6:
                    raise ValueError("simulation timestamps do not match the declared FPS")
                views = {}
                for exported, source in zip(EXPORT_IDS, CAMERA_IDS):
                    view = batch["views"][source]
                    name = f"images/{index:06d}_{exported}.png"
                    (self.directory / name).write_bytes(encode_image(view["rgb"]))
                    scene["cameras"][exported] = {k: view[k] for k in ("width", "height", "K")}
                    views[exported] = {"image": name, "camera_to_world": view["camera_to_world"]}
                scene["frames"].append({"views": views})
                with self.lock:
                    self.written += 1
            origin = np.array(scene["frames"][0]["views"][EXPORT_IDS[1]]["camera_to_world"])
            cv_from_flu = np.array([[0, -1, 0, 0], [0, 0, -1, 0], [1, 0, 0, 0], [0, 0, 0, 1]])
            scene["metadata"]["T_world_scene"] = (origin @ cv_from_flu).tolist()
            (self.directory / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
            with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_STORED) as archive:
                archive.write(self.directory / "scene.json", "scene.json")
                for frame in scene["frames"]:
                    for view in frame["views"].values():
                        if self.stop.is_set():
                            return
                        archive.write(self.directory / view["image"], view["image"])
            prepared = True
        except Exception as exc:  # no partial export can be reported as a usable ZIP
            self.fail(f"三相机采集失败：{exc}")
        finally:
            for cleanup in (self.unsubscribe, renderer.close):
                try:
                    cleanup()
                except Exception as exc:  # each resource must be released even if another cleanup fails
                    self.fail(f"采集资源清理失败：{exc}")
            while not self.queue.empty():
                self.queue.get_nowait()
            self.model = self.source = None
            self.sim = self.unsubscribe = None
            with self.lock:
                try:
                    if prepared and not self.stop.is_set():
                        destination = self.directory / "scene.zip"
                        partial.replace(destination)
                        self.archive = str(destination.resolve())
                    else:
                        partial.unlink(missing_ok=True)
                except OSError as exc:
                    self.error = f"采集文件保存失败：{exc}"
                self.state = "failed" if self.error else "succeeded" if self.archive else "cancelled"
            self.release(self.robot)
            self.done.set()


class CaptureManager:
    """Own recording jobs for this host; exports persist but live job handles are process-local."""

    def __init__(self, sim, cameras, root: Path, *, capacity=4, timeout_s=120):
        self.sim, self.cameras, self.root = sim, cameras, root
        self.capacity, self.timeout_s = capacity, timeout_s
        self.lock = threading.RLock()
        self.jobs = {}
        self.closed = False

    def start(self, body):
        robot, frames, fps = body.get("robot"), body.get("frames", 16), body.get("fps", 10)
        if not isinstance(robot, str) or not robot:
            raise HttpError(400, "需要指定机器人 robot")
        if type(frames) is not int or not 16 <= frames <= 256:
            raise HttpError(400, "frames 必须是 16 至 256 的整数")
        if type(fps) not in (int, float) or not math.isfinite(fps) or not 1 <= fps <= 30:
            raise HttpError(400, "fps 必须在 1 至 30 之间")
        sim = self.sim()
        period = 1 / (fps * sim.timestep)
        if abs(period - round(period)) > 1e-6:
            raise HttpError(400, "采样周期必须是仿真步长的整数倍，请使用 10 fps")
        with self.lock:
            if self.closed:
                raise HttpError(503, "采集服务已关闭")
            with sim.lock:
                sim.camera_pose(robot)
            self.cameras.reserve_capture(robot)
            try:
                job = CaptureJob(sim, robot, frames, fps, self.root, self.cameras.release_capture,
                                 capacity=self.capacity, timeout_s=self.timeout_s)
            except Exception:
                self.cameras.release_capture(robot)
                raise
            self.jobs[job.id] = job
            return job.status()

    def get(self, capture_id):
        with self.lock:
            if capture_id not in self.jobs:
                raise HttpError(404, "找不到采集任务；主机重启后请使用已保存的 ZIP 路径或重新采集")
            return self.jobs[capture_id]

    def close(self):
        with self.lock:
            self.closed = True
            jobs = list(self.jobs.values())
        for job in jobs:
            job.cancel()
        for job in jobs:
            job.thread.join()

    def latest(self, robot):
        with self.lock:
            return next((job.status() for job in reversed(self.jobs.values()) if job.robot == robot), None)

    def interrupt(self, message):
        """Fail active recordings before replacing the simulation they own."""
        with self.lock:
            jobs = [job for job in self.jobs.values() if not job.done.is_set()]
        for job in jobs:
            job.fail(message)
        for job in jobs:
            job.thread.join()

    def status(self, capture_id, wait_seconds=0):
        try:
            wait = float(wait_seconds)
        except (TypeError, ValueError):
            raise HttpError(400, "wait_seconds 必须在 0 至 20 之间") from None
        if not math.isfinite(wait) or not 0 <= wait <= 20:
            raise HttpError(400, "wait_seconds 必须在 0 至 20 之间")
        job = self.get(capture_id)
        job.done.wait(wait)
        return job.status()
