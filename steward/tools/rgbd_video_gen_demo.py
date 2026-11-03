#!/usr/bin/env python3
"""Submit a server demo or local manifest to rgbd_video_gen and verify downloads.

Local manifest mode requires Pillow from Steward's Python dependencies. A saved
scene can also be submitted by the robot Ego Harness rgbd_video_gen_submit tool.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.request
import uuid


def request(base_url, method, path, payload=None, key=None, timeout=300):
    """Call one endpoint; callers retain the same key after unknown POST outcomes."""
    headers = {}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    if key is not None:
        headers["Idempotency-Key"] = key
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def build_scene(demo_dir, num_frames, num_source_views=6):
    """Convert a manifest to 2-64 frames with 1-8 evidence views and at least one target."""
    from PIL import Image

    if not 1 <= num_source_views <= 8:
        raise ValueError("num_source_views must be between 1 and 8.")
    if not 2 <= num_frames <= 64 or num_frames <= num_source_views:
        raise ValueError("Use 2-64 frames with at least num_source_views + 1 frames; explicitly set fewer than 6 evidence views.")
    root = Path(demo_dir).resolve()
    with (root / "manifest_train.jsonl").open(encoding="utf-8") as file:
        record = json.loads(file.readline())
    views = sorted(record["views"], key=lambda view: int(view["view_id"]))[:num_frames]
    if len(views) != num_frames:
        raise ValueError("The manifest must contain the requested 2-64 frames.")
    frames = []
    size = None
    for view in views:
        path = (root / view["rgb_path"]).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Manifest image path leaves the demo directory.")
        with Image.open(path) as image:
            current_size = image.size
            media = {"PNG": "png", "JPEG": "jpeg"}.get(image.format)
        if media is None:
            raise ValueError("Evidence images must be PNG or JPEG.")
        if size is None:
            size = current_size
        if size != current_size or view["K"] != views[0]["K"]:
            raise ValueError("A single reference camera requires matching resolution and K across frames.")
        frames.append({"views": {"front": {
            "image": f"data:image/{media};base64," + base64.b64encode(path.read_bytes()).decode(),
            "camera_to_world": view["c2w"],
        }}})
    return {"format": "rgbd_videogen_scene_v1", "scene_id": record["scene_id"],
            "reference_camera": "front", "cameras": {"front": {
                "width": size[0], "height": size[1], "K": views[0]["K"]}}, "frames": frames}


def download(base_url, result, output_dir, timeout):
    """Download declared job artifacts and publish only size/SHA256-verified files."""
    job = result["job_id"]
    if not re.fullmatch(r"j_[A-Za-z0-9_-]{1,96}", job):
        raise ValueError("Invalid result job_id.")
    root = Path(output_dir)
    root.mkdir(parents=True, exist_ok=True)
    for artifact in result["artifacts"]:
        name = artifact["filename"]
        if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}", name) or name.endswith(".")
                or re.match(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", name, re.I)):
            raise ValueError("Unsafe artifact filename.")
        path = f"/v1/nvs/jobs/{job}/artifacts/{name}"
        temporary = root / f"{name}.{uuid.uuid4().hex}.part"
        try:
            digest = hashlib.sha256()
            total = 0
            with urllib.request.urlopen(base_url.rstrip("/") + path, timeout=timeout) as response, temporary.open("xb") as file:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > artifact["bytes"]:
                        raise ValueError(f"Artifact exceeds declared size: {name}")
                    digest.update(chunk)
                    file.write(chunk)
            if total != artifact["bytes"] or digest.hexdigest() != artifact["sha256"]:
                raise ValueError(f"Artifact integrity check failed: {name}")
            temporary.replace(root / name)
            print(f"[verified] {root / name}")
        finally:
            temporary.unlink(missing_ok=True)


def main():
    """Run a bounded demo submission; print the retry identity before the POST."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("RGBD_VIDEO_GEN_URL", "http://115.120.57.9/nvs"))
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--demo-dir", help="Local directory containing manifest_train.jsonl and images.")
    source.add_argument("--demo", default="waymo080", help="Server-installed demo name.")
    parser.add_argument("--num-frames", type=int, default=16)
    parser.add_argument("--num-source-views", type=int, choices=range(1, 9), default=6,
                        help="Evidence views (default 6); set explicitly for fewer views. Quality may decline away from 6.")
    parser.add_argument("--max-target-views", type=int, default=10)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--request-key", default=None, help="Reuse the printed key and identical options after an uncertain submission.")
    parser.add_argument("--save-scene", help="Write a local manifest-derived scene without sending a request.")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--wait-timeout", type=float, default=900)
    parser.add_argument("--output-dir", default=None)
    args = parser.parse_args()
    if args.poll_seconds <= 0 or args.wait_timeout <= 0:
        parser.error("poll-seconds and wait-timeout must be positive")
    if args.save_scene and not args.demo_dir:
        parser.error("--save-scene requires --demo-dir")
    scene = build_scene(args.demo_dir, args.num_frames, args.num_source_views) if args.demo_dir else {"__demo": args.demo}
    if args.save_scene:
        Path(args.save_scene).write_text(json.dumps(scene) + "\n", encoding="utf-8")
        return 0
    key = args.request_key or "rgbd-demo-" + uuid.uuid4().hex
    print(f"[request_key] {key}", flush=True)
    body = {"scene": scene, "num_source_views": args.num_source_views,
            "max_target_views": args.max_target_views, "num_inference_steps": args.steps,
            "seed": args.seed, "output_fps": 4}
    endpoint = "/v1/nvs/jobs" if args.demo_dir else "/v1/nvs/demo"
    job = request(args.url, "POST", endpoint, body, key)
    job_id = job["job_id"]
    if not re.fullmatch(r"j_[A-Za-z0-9_-]{1,96}", job_id):
        raise ValueError("Invalid submitted job_id.")
    print(f"[accepted] {job_id} {job['state']}", flush=True)
    if not args.wait:
        return 0
    deadline = time.monotonic() + args.wait_timeout
    while job["state"] in {"queued", "running"}:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"Wait expired; job {job_id} remains on the server. Query its status before resubmitting.")
        job = request(args.url, "GET", f"/v1/nvs/jobs/{job_id}", timeout=min(300, remaining))
        if job["job_id"] != job_id:
            raise ValueError("Status belongs to a different job.")
        print(f"[status] {job['state']} {job.get('progress')}", flush=True)
        if job["state"] in {"queued", "running"}:
            time.sleep(min(args.poll_seconds, max(0, deadline - time.monotonic())))
    if job["state"] != "succeeded":
        raise RuntimeError(f"Generation did not succeed: {job}")
    result = request(args.url, "GET", f"/v1/nvs/jobs/{job_id}/result")
    if result["job_id"] != job_id or result["state"] != "succeeded":
        raise ValueError("Result does not identify the successful job.")
    print(f"[metrics] {result['metrics']}")
    download(args.url, result, args.output_dir or f"var/rgbd_video_gen-demo/{job_id}", 600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
