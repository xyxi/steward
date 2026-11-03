"""Encoder-derived gripper/camera transforms agree with independent simulator geometry."""
import copy

import mujoco
import numpy as np
import pytest

from steward.assets.generators import steward_bot
from steward.ego.kinematics import gripper_pose
from steward.ego.runtime import EgoRuntime, RobotLink
from steward.ego.server import ego_api
from steward.math3d import matrix_from_quat
from steward.net import call
from steward.world.cameras import CAMERA_IDS, CameraPipeline
from steward.world.server import StewardHost
from steward.world.sim import WorldSim


@pytest.mark.parametrize("lift,reach,yaw", [(0.3, 0.05, 0), (0.8, 0.4, 1.1), (1.3, 0.7, -2.0)])
def test_forward_kinematics_matches_gripper_in_each_camera_frame(kitchen_scene, lift, reach, yaw):
    sim = WorldSim(kitchen_scene)
    cameras = CameraPipeline(lambda: sim)
    try:
        names = sim.build.names["w:robot-1"]
        with sim.lock:
            for name, value in [(names.joints["lift"], lift), (names.joints["reach"], reach),
                                *zip(names.root_joints, [2.0, -3.0, yaw])]:
                jid = mujoco.mj_name2id(sim.model, mujoco.mjtObj.mjOBJ_JOINT, name)
                sim.data.qpos[sim.model.jnt_qposadr[jid]] = value
            mujoco.mj_forward(sim.model, sim.data)
        packet = cameras.kinematics("w:robot-1")
        pose = gripper_pose(steward_bot().to_dict(), packet)
        assert pose["joint_positions"]["lift"] == lift
        assert pose["joint_positions"]["reach"] == reach
        np.testing.assert_allclose(np.asarray(pose["gripper_to_base"])[:3, 3], [0.26 + reach, 0, lift])
        truth = sim.gripper_pose("w:robot-1")
        gripper_world = np.eye(4)
        gripper_world[:3, :3] = matrix_from_quat(truth["q"])
        gripper_world[:3, 3] = truth["p"]
        for camera in CAMERA_IDS:
            cid = mujoco.mj_name2id(sim.model, mujoco.mjtObj.mjOBJ_CAMERA, names.cameras[camera])
            camera_world = np.eye(4)
            camera_world[:3, :3] = sim.data.cam_xmat[cid].reshape(3, 3) @ np.diag([1, -1, -1])
            camera_world[:3, 3] = sim.data.cam_xpos[cid]
            expected = np.linalg.inv(camera_world) @ gripper_world
            # MJCF rounds mount quaternions during serialization; the robot model retains full precision.
            np.testing.assert_allclose(pose["gripper_to_camera"][camera], expected, atol=1e-6)
        assert cameras._renderer.model is None, "pose queries do not render"
        bad = copy.deepcopy(packet)
        del bad["joint_encoders"]["reach"]
        with pytest.raises(ValueError, match="encoder"):
            gripper_pose(steward_bot().to_dict(), bad)
        bad = copy.deepcopy(packet)
        bad["views"]["head_camera"]["camera_to_reference"][0][0] = 2
        with pytest.raises(ValueError, match="calibration"):
            gripper_pose(steward_bot().to_dict(), bad)
    finally:
        cameras.close()
        sim.stop()


def test_ego_pose_query_needs_no_images_and_capture_pose_uses_the_image_encoder_sample(kitchen_root, monkeypatch):
    host = StewardHost(kitchen_root, scenario="phase0-kitchen")
    runtime = EgoRuntime(RobotLink(host.robot_servers["w:robot-1"].url), steward_bot().to_dict())
    api = ego_api(runtime).start()
    try:
        pose = call("GET", f"{api.url}/ego/gripper/pose")
        assert pose["pose_source"] == "joint_encoders_and_robot_model"
        assert host.cameras._renderer.model is None
        capture = call("POST", f"{api.url}/ego/cameras/capture", {})
        assert capture["gripper_pose"] == pose
        assert capture["gripper_pose"]["stamp"] == capture["stamp"]
        assert runtime.estimator.joints == {}, "calculation uses captured encoders, not a stale perception poll"
        packet = runtime.link.cameras()
        packet["joint_encoders"]["lift"] += 0.1
        packet["stamp"] += 1
        monkeypatch.setattr(runtime.link, "cameras", lambda: packet)
        changed = runtime.capture_cameras()
        assert changed["gripper_pose"]["stamp"] == packet["stamp"]
        assert changed["gripper_pose"]["gripper_to_base"][2][3] == pytest.approx(pose["gripper_to_base"][2][3] + 0.1)
        assert set(pose["gripper_to_camera"]) == set(CAMERA_IDS)
        assert runtime.alerts_view()["active"] == []
    finally:
        api.stop()
        host.stop()
