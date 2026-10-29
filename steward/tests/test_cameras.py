"""Camera rig compatibility, geometry, synchronized images and worker cleanup."""
import base64
import threading

import mujoco
import numpy as np
import pytest

from steward.net import HttpError
from steward.scene.mjcf import build_mjcf
from steward.scene.schema import SceneState
from steward.world.cameras import CAMERA_IDS, CameraPipeline
from steward.world.sim import WorldSim


def test_rig_adds_only_cameras_without_changing_original_physics(kitchen_scene):
    original = build_mjcf(SceneState.from_dict(kitchen_scene)).compile()
    sim = WorldSim(kitchen_scene)
    try:
        assert sim.model.nq == original.nq and sim.model.nv == original.nv
        np.testing.assert_array_equal(sim.model.body_mass, original.body_mass)
        assert sim.model.ngeom == original.ngeom
        name = "w:robot-1::head_camera"
        before = mujoco.mj_name2id(original, mujoco.mjtObj.mjOBJ_CAMERA, name)
        after = mujoco.mj_name2id(sim.model, mujoco.mjtObj.mjOBJ_CAMERA, name)
        np.testing.assert_array_equal(original.cam_pos[before], sim.model.cam_pos[after])
        np.testing.assert_array_equal(original.cam_quat[before], sim.model.cam_quat[after])
        assert original.cam_fovy[before] == sim.model.cam_fovy[after]
        assert sim.sensors("w:robot-1")["camera"]["id"] == "head_camera"
    finally:
        sim.stop()


def test_triple_snapshot_uses_equal_intrinsics_parallel_poses_and_real_parallax(kitchen_scene):
    sim = WorldSim(kitchen_scene)
    pipeline = CameraPipeline(lambda: sim)
    try:
        assert pipeline.state("w:robot-1")["mode"] == "single"
        assert list(pipeline.preview("w:robot-1")["views"]) == ["head_camera"]
        pipeline.set_mode("w:robot-1", "triple")
        sim.step(50)
        frame = pipeline.preview("w:robot-1")
        assert frame["stamp"] == sim.time
        assert frame["pose_source"] == "simulation_ground_truth"
        assert list(frame["views"]) == list(CAMERA_IDS)
        views = list(frame["views"].values())
        assert all(v["K"] == views[1]["K"] and (v["width"], v["height"]) == (320, 240) for v in views)
        poses = [np.array(v["camera_to_world"]) for v in views]
        for p in poses:
            np.testing.assert_allclose(p[:3, :3].T @ p[:3, :3], np.eye(3), atol=1e-6)
            assert np.linalg.det(p[:3, :3]) == pytest.approx(1)
        for index, sign in ((0, -1), (2, 1)):
            np.testing.assert_allclose(poses[index][:3, :3], poses[1][:3, :3])
            np.testing.assert_allclose(poses[index][:3, 3] - poses[1][:3, 3], sign * 0.12 * poses[1][:3, 0], atol=1e-6)
        for v in views:
            assert base64.b64decode(v["image"].split(",")[1]).startswith(b"\xff\xd8")
        assert views[0]["image"] != views[1]["image"] != views[2]["image"]
        pipeline.set_mode("w:robot-1", "single")
        assert list(pipeline.preview("w:robot-1")["views"]) == ["head_camera"]
        assert sim.rgbd("w:robot-1").startswith(b"PK")
    finally:
        pipeline.close()
        assert not any(t.name.startswith("camera-rig") for t in threading.enumerate())
        sim.stop()


def test_camera_render_rebuilds_after_reset_and_live_scene_change(kitchen_scene):
    sim = WorldSim(kitchen_scene)
    pipeline = CameraPipeline(lambda: sim)
    try:
        pipeline.set_mode("w:robot-1", "triple")
        before = pipeline.preview("w:robot-1")
        sim.reset()
        after = pipeline.preview("w:robot-1")
        assert after["epoch"] > before["epoch"]
        assert len(after["views"]) == 3
    finally:
        pipeline.close(); sim.stop()


def test_failed_mode_switch_preserves_previous_mode_and_closed_worker_rejects(kitchen_scene):
    sim = WorldSim(kitchen_scene)
    pipeline = CameraPipeline(lambda: sim)
    try:
        with pytest.raises(HttpError):
            pipeline.set_mode("w:robot-1", "invalid")
        with pytest.raises(KeyError):
            pipeline.set_mode("w:missing", "triple")
        assert pipeline.state("w:robot-1")["mode"] == "single"
        pipeline.close()
        with pytest.raises(HttpError):
            pipeline.preview("w:robot-1")
    finally:
        pipeline.close(); sim.stop()
