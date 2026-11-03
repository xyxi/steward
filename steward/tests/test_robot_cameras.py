"""Three-camera sensing crosses only the robot port and returns relative calibration."""
import base64
import io
import json

import numpy as np
import pytest
from PIL import Image

from steward.assets.generators import steward_bot
from steward.ego.runtime import EgoRuntime, RobotLink
from steward.ego.server import ego_api
from steward.net import HttpError, call
from steward.world.cameras import CAMERA_IDS
from steward.world.server import StewardHost


def test_robot_captures_synchronized_images_without_world_state_or_display_mode_changes(kitchen_root):
    host = StewardHost(kitchen_root, scenario="phase0-kitchen")
    runtime = EgoRuntime(RobotLink(host.robot_servers["w:robot-1"].url), steward_bot().to_dict())
    api = ego_api(runtime).start()
    try:
        assert host.cameras.state("w:robot-1")["mode"] == "single"
        before = call("POST", f"{api.url}/ego/cameras/capture", {})
        assert before["stamp"] == host.sim.time
        assert before["calibration_source"] == "rig_calibration"
        assert list(before["views"]) == list(CAMERA_IDS)
        assert before["reference_camera"] == "head_camera"
        encoded = json.dumps(before)
        for forbidden in ("camera_to_world", "simulation_ground_truth", "w:robot", '"epoch"'):
            assert forbidden not in encoded
        assert set(before) == {"stamp", "calibration_source", "reference_camera", "camera_axes", "views", "gripper_pose"}
        assert before["gripper_pose"]["stamp"] == before["stamp"]
        for camera, view in before["views"].items():
            assert set(view) == {"width", "height", "K", "camera_to_reference", "image"}
            image = Image.open(io.BytesIO(base64.b64decode(view["image"].split(",")[1])))
            assert image.size == (view["width"], view["height"]) == (320, 240)
            relative = np.asarray(view["camera_to_reference"])
            np.testing.assert_allclose(relative[:3, :3].T @ relative[:3, :3], np.eye(3), atol=1e-10)
            assert np.linalg.det(relative[:3, :3]) == pytest.approx(1)
            assert view["K"] == before["views"]["head_camera"]["K"]
        np.testing.assert_allclose(before["views"]["head_camera"]["camera_to_reference"], np.eye(4))
        for camera, sign in ((CAMERA_IDS[0], -1), (CAMERA_IDS[2], 1)):
            relative = np.asarray(before["views"][camera]["camera_to_reference"])
            np.testing.assert_allclose(relative[:3, 3], [sign * 0.12, 0, 0], atol=1e-10)
        host.sim.step(20)
        after = call("POST", f"{api.url}/ego/cameras/capture", {})
        assert after["stamp"] > before["stamp"]
        for camera in CAMERA_IDS:
            np.testing.assert_allclose(after["views"][camera]["camera_to_reference"],
                                       before["views"][camera]["camera_to_reference"], atol=1e-10)
        assert host.cameras.state("w:robot-1")["mode"] == "single"
        assert runtime.alerts_view()["active"] == []
        host.cameras.close()
        with pytest.raises(HttpError) as error:
            call("POST", f"{api.url}/ego/cameras/capture", {})
        assert error.value.status == 503
        assert runtime.alerts_view()["active"] == []
    finally:
        api.stop()
        host.stop()
