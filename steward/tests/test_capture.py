"""SLARM ZIP synchronization, physical transforms and bounded capture failure paths."""
import json
import threading
import zipfile

import numpy as np
import pytest

from steward.net import HttpError
from steward.world.cameras import CameraPipeline
from steward.world.capture import CaptureManager, EXPORT_IDS
from steward.world.sim import WorldSim


@pytest.fixture
def rig(kitchen_scene, tmp_path):
    sim = WorldSim(kitchen_scene)
    cameras = CameraPipeline(lambda: sim)
    manager = CaptureManager(lambda: sim, cameras, tmp_path, capacity=32)
    try:
        yield sim, cameras, manager
    finally:
        manager.close()
        cameras.close()
        sim.stop()


def begin(rig, **kwargs):
    sim, cameras, manager = rig
    cameras.set_mode("w:robot-1", "triple")
    result = manager.start({"robot": "w:robot-1", **kwargs})
    return manager.get(result["capture_id"])


def test_zip_has_48_synchronized_images_calibration_and_world_transform(rig):
    sim, cameras, manager = rig
    job = begin(rig)
    sim.step(job.stride * 15)
    assert job.done.wait(20)
    result = job.status()
    assert result["status"] == "succeeded", result
    assert result["written_frames"] == 16
    with zipfile.ZipFile(result["archive_path"]) as archive:
        assert len(archive.namelist()) == 49
        scene = json.loads(archive.read("scene.json"))
        assert scene["format"] == "slarm_scene_v1" and scene["fps"] == 10
        assert len(scene["frames"]) == 16
        assert list(scene["cameras"]) == list(EXPORT_IDS)
        assert scene["metadata"]["pose_source"] == "simulation_ground_truth"
        for frame in scene["frames"]:
            for view in frame["views"].values():
                assert archive.read(view["image"]).startswith(b"\x89PNG")
            poses = [np.array(frame["views"][key]["camera_to_world"]) for key in EXPORT_IDS]
            np.testing.assert_allclose(poses[2][:3, 3] - poses[0][:3, 3], 0.24 * poses[1][:3, 0], atol=1e-6)
        cv = np.array(scene["frames"][0]["views"][EXPORT_IDS[1]]["camera_to_world"])
        flu = np.array(scene["metadata"]["T_world_scene"])
        np.testing.assert_allclose(flu[:3, 0], cv[:3, 2])
        np.testing.assert_allclose(flu[:3, 1], -cv[:3, 0])
    assert not sim._step_listeners
    assert not cameras.state("w:robot-1")["capture_active"]


def test_capture_validation_and_exclusive_mode(rig):
    _, cameras, manager = rig
    with pytest.raises(HttpError):
        manager.start({"robot": "w:robot-1"})
    for args in ({"frames": 15}, {"fps": 30}, {"fps": float("nan")}, {"frames": True}):
        with pytest.raises(HttpError):
            manager.start({"robot": "w:robot-1", **args})
    job = begin(rig)
    with pytest.raises(HttpError):
        cameras.set_mode("w:robot-1", "single")
    with pytest.raises(HttpError):
        manager.start({"robot": "w:robot-1"})
    job.cancel()
    assert job.done.wait(10)
    assert job.status()["status"] == "cancelled" and job.status()["archive_path"] is None
    cameras.set_mode("w:robot-1", "single")


def test_reset_fails_recording_instead_of_mixing_epochs(rig):
    sim, _, _ = rig
    job = begin(rig)
    sim.reset()
    sim.step(1)
    assert job.done.wait(10)
    assert job.status()["status"] == "failed"
    assert job.status()["archive_path"] is None
    assert not sim._step_listeners


def test_paused_simulation_times_out_and_releases_mode(rig):
    sim, cameras, manager = rig
    manager.timeout_s = 0.1
    job = begin(rig)
    assert job.done.wait(10)
    assert job.status()["status"] == "failed"
    assert "超时" in job.status()["error"]
    assert not sim._step_listeners
    cameras.set_mode("w:robot-1", "single")


def test_overflow_fails_without_blocking_physics_or_publishing_zip(rig, monkeypatch):
    import steward.world.capture as capture
    sim, _, manager = rig
    manager.capacity = 1
    entered, release = threading.Event(), threading.Event()
    real = capture.encode_image
    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return real(*args, **kwargs)
    monkeypatch.setattr(capture, "encode_image", blocked)
    job = begin(rig)
    try:
        assert entered.wait(10)
        sim.step(job.stride * 3)
        assert job.stop.is_set()
        assert "队列已满" in job.status()["error"]
    finally:
        release.set()
    assert job.done.wait(10)
    assert job.status()["status"] == "failed" and job.status()["archive_path"] is None
    assert not list(job.directory.glob("*.part"))


def test_worker_start_failure_removes_hook_and_releases_capture(rig, monkeypatch):
    sim, cameras, manager = rig
    cameras.set_mode("w:robot-1", "triple")
    def failed_start(thread):
        raise RuntimeError("worker unavailable")
    monkeypatch.setattr(threading.Thread, "start", failed_start)
    with pytest.raises(RuntimeError, match="worker unavailable"):
        manager.start({"robot": "w:robot-1"})
    assert not sim._step_listeners
    assert not cameras.state("w:robot-1")["capture_active"]
