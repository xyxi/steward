"""Port takeover ends only identified Steward trees and waits for all descendants."""
import os
import json
from types import SimpleNamespace

import psutil
import pytest

from steward import instances
from steward.net import PortInUseError


class Process:
    def __init__(self, pid, cwd, args, parent=None):
        self.pid, self._cwd, self._args, self._parent = pid, cwd, args, parent
        self.descendants = []
        self.terminated = self.killed = False

    def cwd(self):
        return str(self._cwd)

    def cmdline(self):
        return self._args

    def create_time(self):
        return float(self.pid)

    def parent(self):
        return self._parent

    def parents(self):
        return []

    def children(self, recursive=False):
        return self.descendants

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def setup_processes(monkeypatch, tmp_path, listeners):
    root = Process(10001, tmp_path, ["python.exe", "-m", "steward.cli", "up"])
    child = Process(10002, tmp_path, ["python.exe", "-m", "steward.cli", "ego"], root)
    root.descendants = [child]
    other = Process(10003, tmp_path, ["python.exe", "unrelated.py"])
    current = Process(os.getpid(), tmp_path, ["python.exe", "-m", "steward.cli", "up"])
    processes = {p.pid: p for p in [root, child, other, current]}
    monkeypatch.setattr(instances.psutil, "Process", lambda pid=None: processes[pid or os.getpid()])
    connections = [SimpleNamespace(status=psutil.CONN_LISTEN, pid=pid,
                                  laddr=SimpleNamespace(ip="127.0.0.1", port=port)) for port, pid in listeners]
    monkeypatch.setattr(instances.psutil, "net_connections", lambda kind: connections)
    monkeypatch.setattr(instances.psutil, "wait_procs", lambda procs, timeout: (procs, []))
    monkeypatch.setattr(instances, "_port_available", lambda port: False)
    return root, child, other


def test_two_owned_ports_stop_one_complete_instance_tree(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, 10001), (7420, 10002)])
    assert instances.replace_port_owners([7400, 7410, 7420], tmp_path) == [root.pid]
    assert root.terminated and child.terminated
    assert not other.terminated


def test_unrelated_listener_blocks_all_termination(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, 10001), (7410, 10003)])
    with pytest.raises(PortInUseError) as error:
        instances.replace_port_owners([7400, 7410], tmp_path)
    assert error.value.port == 7410
    assert not any(p.terminated for p in [root, child, other])


def test_other_checkouts_and_current_process_are_not_stopped(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, 10001)])
    with pytest.raises(PortInUseError):
        instances.replace_port_owners([7400], tmp_path / "other-checkout")
    assert not root.terminated and not child.terminated
    setup_processes(monkeypatch, tmp_path, [(7400, os.getpid())])
    with pytest.raises(PortInUseError):
        instances.replace_port_owners([7400], tmp_path)


def test_only_requested_fixed_ports_trigger_replacement(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, 10001), (7410, 10003)])
    assert instances.replace_port_owners([0], tmp_path) == []
    assert instances.replace_port_owners([7400, 0], tmp_path) == [root.pid]
    assert root.terminated and child.terminated and not other.terminated


def test_unresponsive_old_processes_are_killed_and_unstopped_ones_block_startup(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, 10001)])
    monkeypatch.setattr(instances.psutil, "wait_procs", lambda procs, timeout: (
        [p for p in procs if p.killed], [p for p in procs if not p.killed]))
    assert instances.replace_port_owners([7400], tmp_path, timeout=0) == [root.pid]
    assert root.killed and child.killed and not other.killed
    root.killed = child.killed = False
    monkeypatch.setattr(instances.psutil, "wait_procs", lambda procs, timeout: ([], procs))
    with pytest.raises(instances.InstanceStopError, match="did not exit"):
        instances.replace_port_owners([7400], tmp_path, timeout=0)


def test_windows_batch_launcher_and_venv_wrapper_belong_to_the_same_instance(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7420, 10002)])
    launcher = Process(10004, tmp_path, ["cmd.exe", "/d", "/c", "run_windows.bat"])
    root._args = ["python.exe", "-c", "from steward.cli import main; sys.exit(main())", "up"]
    root._parent = launcher
    launcher.descendants = [root, child]
    assert instances.replace_port_owners([7420], tmp_path) == [launcher.pid]
    assert launcher.terminated and root.terminated and child.terminated and not other.terminated


def _record_owner(tmp_path, port, process, **extra):
    path = instances._record_path(tmp_path, port)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "checkout": str(tmp_path.resolve()), "port": port,
                               "pid": process.pid, "created_at": process.create_time(), "token": "old", **extra}),
                    encoding="utf-8")
    return path


@pytest.mark.parametrize("missing_pid", [0, None])
def test_windows_ownerless_listener_uses_verified_instance_record(monkeypatch, tmp_path, missing_pid):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, missing_pid), (7420, missing_pid)])
    _record_owner(tmp_path, 7400, root)
    _record_owner(tmp_path, 7420, root)
    assert instances.replace_port_owners([7400, 7420], tmp_path) == [root.pid]
    assert root.terminated and child.terminated and not other.terminated


def test_missing_or_stale_owner_records_do_not_authorize_termination(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, 0)])
    for process, extra in [(None, {}), (root, {"created_at": root.create_time() - 1}), (other, {})]:
        if process:
            _record_owner(tmp_path, 7400, process, **extra)
        with pytest.raises(PortInUseError):
            instances.replace_port_owners([7400], tmp_path)
        assert not any(p.terminated for p in [root, child, other])


def test_instance_records_publish_process_lifetime_and_replace_old_records(monkeypatch, tmp_path):
    root, _, _ = setup_processes(monkeypatch, tmp_path, [])
    instances.register_instance([7400, 7420, 0], tmp_path)
    first = instances._record_path(tmp_path, 7400)
    second = instances._record_path(tmp_path, 7420)
    assert not instances._record_path(tmp_path, 0).exists()
    value = json.loads(second.read_text(encoding="utf-8"))
    assert value["pid"] == os.getpid() and value["created_at"] == float(os.getpid())
    monkeypatch.setattr(instances.psutil, "Process", lambda pid=None: root)
    instances.register_instance([7400, 7420], tmp_path)
    assert json.loads(first.read_text(encoding="utf-8"))["pid"] == root.pid
    assert json.loads(second.read_text(encoding="utf-8"))["created_at"] == root.create_time()


def test_stale_pid_zero_listener_does_not_block_binding(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [(7400, 0)])
    monkeypatch.setattr(instances, "_port_available", lambda port: True)
    assert instances.replace_port_owners([7400], tmp_path) == []
    assert not any(p.terminated for p in [root, child, other])


def test_registered_instance_is_replaced_when_windows_omits_its_listener(monkeypatch, tmp_path):
    root, child, other = setup_processes(monkeypatch, tmp_path, [])
    _record_owner(tmp_path, 7400, root)
    assert instances.replace_port_owners([7400], tmp_path) == [root.pid]
    assert root.terminated and child.terminated and not other.terminated
