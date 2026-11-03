"""Replace port-owning Steward instances from this checkout before Windows startup."""
from __future__ import annotations

import os
import errno
import json
import uuid
import socket
from pathlib import Path

import psutil

from steward.net import PortInUseError


class InstanceStopError(RuntimeError):
    """An identified old instance could not be stopped; starting a replacement is unsafe."""


def _record_path(checkout: Path, port: int) -> Path:
    return checkout / "var" / "dsh" / "instances" / f"{port}.json"


def register_instance(ports: list[int], checkout: Path) -> None:
    """Record this live instance's fixed ports and PID lifetime after all services bind.

    Records remain after exit so the next startup can resolve Windows listeners with owner
    PID 0. PID creation time prevents PID reuse from authorizing termination. Each successful
    replacement atomically publishes its records; old processes never delete newer records.
    """
    process = psutil.Process()
    token = uuid.uuid4().hex
    try:
        for port in sorted(set(ports) - {0}):
            path = _record_path(checkout, port)
            path.parent.mkdir(parents=True, exist_ok=True)
            value = {"version": 1, "pid": process.pid, "created_at": process.create_time(),
                     "checkout": str(checkout.resolve()), "port": port, "token": token}
            temporary = path.with_suffix(f".{token}.tmp")
            try:
                temporary.write_text(json.dumps(value) + "\n", encoding="utf-8")
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
    except (OSError, psutil.Error) as error:
        raise InstanceStopError(f"Unable to record Steward instance ownership: {error}") from error


def _registered_owner(port: int, checkout: Path) -> psutil.Process | None:
    try:
        value = json.loads(_record_path(checkout, port).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None  # An older instance may not have an ownership record.
    except (OSError, ValueError) as error:
        raise InstanceStopError(f"Cannot read instance ownership for port {port}: {error}") from error
    if (not isinstance(value, dict) or value.get("version") != 1 or value.get("port") != port
            or not isinstance(value.get("pid"), int) or value["pid"] <= 0
            or not isinstance(value.get("created_at"), (int, float))
            or value.get("checkout") != str(checkout.resolve())):
        raise InstanceStopError(f"Invalid Steward instance ownership record for port {port}.")
    try:
        process = psutil.Process(value["pid"])
        if process.create_time() == value["created_at"] and _is_steward(process, checkout):
            return process
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None  # A stale record or inaccessible identity never authorizes termination.
    return None


def _port_available(port: int) -> bool:
    try:
        with socket.socket() as probe:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            probe.bind(("127.0.0.1", port))
    except OSError as error:
        if error.errno == errno.EADDRINUSE or getattr(error, "winerror", None) == 10013:
            return False
        raise InstanceStopError(f"Cannot verify the listener on port {port}: {error}") from error
    return True


def _is_steward(process: psutil.Process, checkout: Path) -> bool:
    try:
        args = process.cmdline()
        if Path(process.cwd()).resolve() != checkout.resolve():
            return False
        if args and Path(args[0]).name.lower() in ("cmd", "cmd.exe"):
            lowered = [arg.lower() for arg in args]
            if "/c" in lowered:
                index = lowered.index("/c")
                return (len(args) > index + 1
                        and Path(args[index + 1].strip('"')).name.lower() == "run_windows.bat")
            return False
        if "-m" in args:
            index = args.index("-m")
            return args[index + 1:index + 2] == ["steward.cli"] and any(
                command in args[index + 2:] for command in ("up", "world", "ego"))
        if "-c" in args:
            index = args.index("-c")
            return (len(args) > index + 1 and "from steward.cli import main" in args[index + 1]
                    and "sys.exit(main())" in args[index + 1]
                    and any(command in args[index + 2:] for command in ("up", "world", "ego")))
        return False
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False  # An unavailable process identity never authorizes terminating it.


def replace_port_owners(ports: list[int], checkout: Path, timeout: float = 10.0) -> list[int]:
    """Stop old Steward trees owning the selected ports and await their exit.

    Only instances launched from this checkout qualify. All owners are checked before any
    termination; an unrelated listener or an ancestor of this process blocks replacement.
    Ephemeral port requests (0) are excluded. Returned ids name stopped instance roots.
    """
    wanted = set(ports) - {0}
    if not wanted:
        return []
    try:
        protected = {os.getpid(), *(process.pid for process in psutil.Process().parents())}
        owners = {}
        resolved_ports = set()

        def add_owner(process: psutil.Process, port: int) -> None:
            if process.pid in protected:
                raise PortInUseError("startup", "127.0.0.1", port)
            parent = process.parent()
            while parent is not None and parent.pid not in protected and _is_steward(parent, checkout):
                process, parent = parent, parent.parent()
            owners[process.pid] = process

        # Windows may omit active listeners from the TCP table, as well as reporting PID 0.
        for port in sorted(wanted):
            process = _registered_owner(port, checkout)
            if process is not None and not _port_available(port):
                add_owner(process, port)
                resolved_ports.add(port)
        for connection in psutil.net_connections(kind="tcp"):
            if (connection.status != psutil.CONN_LISTEN or not connection.laddr
                    or connection.laddr.port not in wanted
                    or connection.laddr.ip not in ("127.0.0.1", "0.0.0.0", "::", "::1")):
                continue
            port = connection.laddr.port
            if port in resolved_ports:
                continue
            if connection.pid in protected:
                raise PortInUseError("startup", "127.0.0.1", port)
            if not connection.pid:
                if _port_available(port):
                    continue  # A stale PID-0 LISTEN row does not establish an occupied socket.
                process = _registered_owner(port, checkout)
                if process is None:
                    raise PortInUseError("unidentified listener (Windows reported no owner PID)", "127.0.0.1", port)
            else:
                process = psutil.Process(connection.pid)
            if not _is_steward(process, checkout):
                raise PortInUseError("non-Steward process", "127.0.0.1", port)
            add_owner(process, port)
        targets = {}
        for process in owners.values():
            for child in reversed(process.children(recursive=True)):
                if child.pid in protected:
                    raise InstanceStopError("The old instance contains this startup process; stop it manually.")
                targets[child.pid] = child
            targets[process.pid] = process
        for process in targets.values():
            try:
                process.terminate()
            except psutil.NoSuchProcess:
                continue  # A descendant may already have exited with its parent.
        _, alive = psutil.wait_procs(list(targets.values()), timeout=timeout)
        for process in alive:
            try:
                process.kill()
            except psutil.NoSuchProcess:
                continue  # The process exited between the wait and forced termination.
        _, alive = psutil.wait_procs(alive, timeout=timeout)
        if alive:
            raise InstanceStopError(f"Old Steward processes did not exit: {[process.pid for process in alive]}")
        return sorted(owners)
    except psutil.Error as error:
        raise InstanceStopError(f"Unable to inspect or stop the old Steward instance: {error}") from error
