"""Exercise the demo's explicit URL and verified-output behavior against local HTTP."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import threading

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "tools" / "rgbd_video_gen_demo.py"
spec = importlib.util.spec_from_file_location("rgbd_demo", SCRIPT)
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


@pytest.fixture
def remote():
    payload = b"demo generated file"
    calls = []
    state = {"corrupt": False}
    artifact = {"filename": "clip.mp4", "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    result = {"job_id": "j_demo", "state": "succeeded", "metrics": {}, "artifacts": [artifact]}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, body, self.headers.get("Idempotency-Key")))
            self.send_response(202)
            self.end_headers()
            self.wfile.write(json.dumps({"job_id": "j_demo", "state": "queued"}).encode())

        def do_GET(self):
            calls.append((self.path, None, None))
            self.send_response(200)
            self.end_headers()
            if self.path.endswith("/clip.mp4"):
                self.wfile.write(b"bad" if state["corrupt"] else payload)
            else:
                self.wfile.write(json.dumps(result).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/nvs", result, payload, calls, state
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_cli_url_controls_submission_polling_and_download(remote, tmp_path):
    url, _result, payload, calls, _state = remote
    completed = subprocess.run([sys.executable, str(SCRIPT), "--url", url, "--demo", "waymo080",
                                "--request-key", "test-rgbd-demo", "--wait", "--output-dir", str(tmp_path)],
                               capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    assert (tmp_path / "clip.mp4").read_bytes() == payload
    assert calls[0] == ("/nvs/v1/nvs/demo", {"scene": {"__demo": "waymo080"}, "num_source_views": 6,
                       "max_target_views": 10, "num_inference_steps": 30, "seed": 1234, "output_fps": 4}, "test-rgbd-demo")
    assert all(call[0].startswith("/nvs/") for call in calls)


def test_corrupt_download_is_not_published(remote, tmp_path):
    url, result, _payload, _calls, state = remote
    state["corrupt"] = True
    with pytest.raises(ValueError, match="integrity"):
        demo.download(url, result, tmp_path, 5)
    assert list(tmp_path.iterdir()) == []


def test_artifact_path_cannot_leave_output_directory(remote, tmp_path):
    url, result, _payload, _calls, _state = remote
    result["artifacts"][0]["filename"] = "../escape"
    with pytest.raises(ValueError, match="Unsafe"):
        demo.download(url, result, tmp_path, 5)


def test_scene_builder_retains_png_mime_and_rejects_changing_intrinsics(tmp_path):
    from PIL import Image

    Image.new("RGB", (32, 32)).save(tmp_path / "frame.png")
    k = [[32, 0, 16], [0, 32, 16], [0, 0, 1]]
    record = {"scene_id": "fixture", "views": [{"view_id": str(i), "rgb_path": "frame.png", "K": k,
               "c2w": [[1, 0, 0, i], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]} for i in range(7)]}
    manifest = tmp_path / "manifest_train.jsonl"
    manifest.write_text(json.dumps(record) + "\n")
    scene = demo.build_scene(tmp_path, 7)
    assert scene["frames"][0]["views"]["front"]["image"].startswith("data:image/png;base64,")
    record["views"][1]["K"] = [[40, 0, 16], [0, 40, 16], [0, 0, 1]]
    manifest.write_text(json.dumps(record) + "\n")
    with pytest.raises(ValueError, match="matching resolution and K"):
        demo.build_scene(tmp_path, 7)


@pytest.fixture
def flexible_manifest(tmp_path):
    from PIL import Image

    Image.new("RGB", (32, 32)).save(tmp_path / "frame.png")
    views = [{"view_id": str(i), "rgb_path": "frame.png", "K": [[32, 0, 16], [0, 32, 16], [0, 0, 1]],
              "c2w": [[1, 0, 0, i], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]} for i in range(9)]
    (tmp_path / "manifest_train.jsonl").write_text(json.dumps({"scene_id": "flexible", "views": views}) + "\n")
    return tmp_path


@pytest.mark.parametrize("sources", [1, 3, 8])
def test_scene_builder_supports_flexible_evidence_counts(flexible_manifest, sources):
    scene = demo.build_scene(flexible_manifest, sources + 1, sources)
    assert len(scene["frames"]) == sources + 1


@pytest.mark.parametrize("frames,sources", [(1, 1), (4, 6), (3, 3), (10, 9), (2, 0), (65, 1)])
def test_scene_builder_rejects_missing_targets_and_out_of_range_counts(flexible_manifest, frames, sources):
    with pytest.raises(ValueError):
        demo.build_scene(flexible_manifest, frames, sources)


def test_cli_transmits_three_evidence_views_as_a_top_level_generation_parameter(remote, flexible_manifest):
    url, _result, _payload, calls, _state = remote
    completed = subprocess.run([sys.executable, str(SCRIPT), "--url", url, "--demo-dir", str(flexible_manifest),
                                "--num-frames", "4", "--num-source-views", "3", "--request-key", "three-camera-demo"],
                               capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    path, body, key = calls[0]
    assert path == "/nvs/v1/nvs/jobs"
    assert body["num_source_views"] == 3
    assert len(body["scene"]["frames"]) == 4
    assert "num_source_views" not in body["scene"]
    assert key == "three-camera-demo"
