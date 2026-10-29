"""Operator chat: World Harness and Ego Harness turns, and exclusive robot control."""

from __future__ import annotations

import json
import os
import shlex
import sys
import time
from types import SimpleNamespace

import pytest

from steward.assets.generators import steward_bot
from steward.ego.runtime import EgoRuntime, RobotLink
from steward.net import JsonServer
from steward.world.chat import ChatConfig, HarnessChat
from steward.world.server import StewardHost

EVENTS = [
    {"type": "session", "sessionId": "session-1"},
    {"type": "tool_call", "callId": "c1", "tool": "some_tool", "input": {"action": "x"}},
    {"type": "tool_result", "callId": "c1", "status": "completed", "result": "{\"ok\": true}"},
    {"type": "text", "text": "完成"},
    {"type": "final", "sessionId": "session-1", "text": "完成"},
]


def _fake_dsh(tmp_path, *, wait=False):
    """A stand-in launcher that records argv, stdin and the patch overlay, then prints run events."""
    program = tmp_path / "fake_dsh.py"
    program.write_text(
        "import json, os, sys, time\nfrom pathlib import Path\n"
        "sys.stdin.reconfigure(encoding='utf-8')\nsys.stdout.reconfigure(encoding='utf-8')\n"
        "home = Path(os.environ['DSH_HOME'])\nargs = sys.argv[1:]\n"
        "patch = Path(args[args.index('--patch') + 1])\n"
        "(home / 'patch.yml').write_text(patch.read_text(encoding='utf-8'), encoding='utf-8')\n"
        "with (home / 'argv').open('a', encoding='utf-8') as output:\n"
        "    output.write('\\n'.join(args) + '\\n\\n')\n"
        "(home / 'stdin').write_text(sys.stdin.read(), encoding='utf-8')\n"
        "(home / 'cwd').write_text(Path.cwd().as_posix(), encoding='utf-8')\n"
        f"for event in {EVENTS[:1] if wait else EVENTS!r}:\n"
        "    print(json.dumps(event, ensure_ascii=False), flush=True)\n"
        + ("time.sleep(60)\n" if wait else ""), encoding="utf-8")
    script = tmp_path / ("dsh.cmd" if os.name == "nt" else "dsh")
    launcher = (f'@echo off\n"{sys.executable}" "{program}" %*\n' if os.name == "nt"
                else f'#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(program))} "$@"\n')
    script.write_text(launcher, encoding="utf-8")
    script.chmod(0o755)
    return script


def test_console_uses_the_platform_dsh_launcher():
    from steward.cli import _chat_config

    config = _chat_config(SimpleNamespace(world_harness="world", robot_harness=None))
    assert config.dsh.name == ("dsh.cmd" if os.name == "nt" else "dsh")


def _home(tmp_path, name: str, profile: str):
    home = tmp_path / name
    (home / "profiles" / profile).mkdir(parents=True)
    return home


def _wait_idle(chat: HarnessChat, key: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while chat.agents[key].busy and time.time() < deadline:
        time.sleep(0.02)
    assert not chat.agents[key].busy


def test_world_chat_keeps_its_session_and_targets_this_hosts_wca(tmp_path):
    world = _home(tmp_path, "world", "world-task")
    chat = HarnessChat(ChatConfig(dsh=_fake_dsh(tmp_path), cwd=tmp_path, env_file=tmp_path / ".env", world_home=world),
                       lambda: "http://127.0.0.1:7999")
    chat.send("world", "把杯子放到桌子上")
    _wait_idle(chat, "world")
    chat.send("world", "再放回去")
    _wait_idle(chat, "world")
    state = chat.state()
    assert [m["role"] for m in state["messages"]] == ["user", "tool", "assistant", "user", "tool", "assistant"]
    assert {m["agent"] for m in state["messages"]} == {"world"}
    assert state["messages"][1]["status"] == "completed" and state["agents"]["world"]["sessionId"] == "session-1"
    turns = (world / "argv").read_text().split("\n\n")
    assert "--session-id" not in turns[0] and "--session-id\nsession-1" in turns[1]
    assert "http://127.0.0.1:7999" in (world / "patch.yml").read_text()
    assert (world / "stdin").read_text(encoding="utf-8").startswith("操作员请求：")
    assert chat.state(since=state["messages"][-1]["id"])["messages"] == []
    assert not state["agents"]["robot"]["available"]


def test_robot_chat_takes_control_for_the_turn_and_gives_it_back(tmp_path):
    robot = _home(tmp_path, "robot-1", "ego")
    calls = []

    def control(q, b):
        calls.append(b["action"])
        assert b["owner"] == "operator"
        return {"owner": "operator" if b["action"] == "acquire" else None}

    ego = JsonServer({("POST", "/ego/control"): control, ("GET", "/ego/control"): lambda q, b: {"owner": None}}).start()
    try:
        chat = HarnessChat(ChatConfig(dsh=_fake_dsh(tmp_path), cwd=tmp_path, env_file=tmp_path / ".env",
                                      robot_home=robot, ego_api=ego.url), lambda: "unused")
        chat.send("robot", "把杯子放到餐桌上")
        _wait_idle(chat, "robot")
    finally:
        ego.stop()
    assert calls == ["acquire", "release"]
    patch = (robot / "patch.yml").read_text()
    assert "steward-ego-runtime" in patch and ego.url in patch and "owner: operator" in patch
    assert (robot / "cwd").read_text().strip().endswith("robot-1/workspace"), "the robot runs in its empty workspace"
    stdin = (robot / "stdin").read_text(encoding="utf-8")
    assert stdin.startswith("你是家用服务机器人") and "World State" not in stdin
    assert [m["agent"] for m in chat.state()["messages"]] == ["robot"] * 3


def test_stopping_a_robot_turn_ends_the_run_and_releases_control(tmp_path):
    robot = _home(tmp_path, "robot-1", "ego")
    script = _fake_dsh(tmp_path, wait=True)
    calls = []

    def control(q, b):
        calls.append(b["action"])
        return {"owner": None}

    ego = JsonServer({("POST", "/ego/control"): control, ("GET", "/ego/control"): lambda q, b: {"owner": None},
                      ("POST", "/skill/stop"): lambda q, b: calls.append("stop") or {"stopped": None}}).start()
    try:
        chat = HarnessChat(ChatConfig(dsh=script, cwd=tmp_path, env_file=tmp_path / ".env", robot_home=robot,
                                      ego_api=ego.url), lambda: "unused")
        chat.send("robot", "去拿椅子")
        deadline = time.time() + 5
        while chat.agents["robot"].session_id is None and time.time() < deadline:
            time.sleep(0.02)
        started = time.time()
        assert chat.cancel("robot") == {"stopped": True}
        _wait_idle(chat, "robot")
        assert time.time() - started < 5
    finally:
        chat.stop()
        _wait_idle(chat, "robot")
        ego.stop()
    assert calls == ["acquire", "stop", "release"]
    roles = [m["role"] for m in chat.state()["messages"]]
    assert "system" in roles and "error" not in roles
    assert chat.cancel("robot") == {"stopped": False}


def test_shuttle_pauses_while_an_operator_controls_the_robot():
    from steward.mission import _wait_for_control

    owners = iter(["operator", "operator", None])
    api = JsonServer({("GET", "/ego/control"): lambda q, b: {"owner": next(owners)}}).start()
    waits = []
    try:
        _wait_for_control(api.url, waits.append, poll_s=0.01)
    finally:
        api.stop()
    assert waits == ["operator"]


def test_ego_runtime_control_blocks_other_clients_until_released(kitchen_root, tmp_path):
    host = StewardHost(kitchen_root, scenario="phase0-kitchen", run_dir=tmp_path)
    runtime = EgoRuntime(RobotLink(host.robot_servers["w:robot-1"].url), steward_bot().to_dict())
    try:
        runtime._poll_once()
        assert runtime.acquire_control("operator") == {"owner": "operator"}
        with pytest.raises(PermissionError, match="controlled by operator"):
            runtime.explore()
        with pytest.raises(PermissionError, match="controlled by operator"):
            runtime.run("rcpt-x")
        with pytest.raises(KeyError):
            runtime.run("rcpt-x", owner="operator")
        with pytest.raises(PermissionError, match="already controlled"):
            runtime.acquire_control("someone-else")
        runtime.release_control("someone-else")
        assert runtime.control() == {"owner": "operator"}
        runtime.release_control("operator")
        assert runtime.control() == {"owner": None}
        with pytest.raises(KeyError):
            runtime.run("rcpt-x")
    finally:
        runtime.executor.cancel()
        host.stop()
