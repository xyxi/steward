"""JSON-over-HTTP services: binding a fixed port that a stopped service still holds."""

from __future__ import annotations

import socket
import threading

import pytest

from steward.net import JsonServer, PortInUseError, call


def _held_port() -> socket.socket:
    held = socket.socket()
    held.bind(("127.0.0.1", 0))
    held.listen()
    return held


def test_a_fixed_port_freed_within_the_wait_is_bound():
    held = _held_port()
    port = held.getsockname()[1]
    threading.Timer(0.6, held.close).start()
    server = JsonServer({}, port=port, name="probe", bind_wait_s=5.0).start()
    try:
        assert server.port == port
    finally:
        server.stop()


def test_a_fixed_port_still_held_after_the_wait_fails_loudly():
    held = _held_port()
    try:
        with pytest.raises(PortInUseError) as error:
            JsonServer({}, port=held.getsockname()[1], name="probe", bind_wait_s=0.6)
        assert error.value.service == "probe"
        assert error.value.host == "127.0.0.1"
        assert error.value.port == held.getsockname()[1]
    finally:
        held.close()


def test_a_running_service_exclusively_owns_its_port():
    first = JsonServer({("GET", "/identity"): lambda q, b: {"instance": "first"}}).start()
    try:
        second = None
        with pytest.raises(OSError):
            try:
                second = JsonServer({}, port=first.port)
            finally:
                if second is not None:
                    second.stop()
        assert call("GET", f"{first.url}/identity") == {"instance": "first"}
    finally:
        first.stop()


def test_a_stopped_service_port_can_be_used_by_a_new_instance():
    first = JsonServer({("GET", "/identity"): lambda q, b: {"instance": "first"}}).start()
    port = first.port
    try:
        assert call("GET", f"{first.url}/identity") == {"instance": "first"}
    finally:
        first.stop()
    second = JsonServer({("GET", "/identity"): lambda q, b: {"instance": "second"}}, port=port).start()
    try:
        assert call("GET", f"{second.url}/identity") == {"instance": "second"}
    finally:
        second.stop()


def test_cli_reports_an_occupied_port_without_a_traceback(monkeypatch, capsys):
    from steward import cli

    def occupied(args):
        raise PortInUseError("wca", "127.0.0.1", 7400)

    monkeypatch.setattr(cli, "cmd_up", occupied)
    assert cli.main(["up"]) == 1
    message = capsys.readouterr().err
    assert "127.0.0.1:7400 is already in use" in message
    assert "Stop the existing service" in message
    assert "Traceback" not in message


def test_cli_does_not_hide_other_startup_errors(monkeypatch):
    from steward import cli

    def broken(args):
        raise OSError("unrelated startup failure")

    monkeypatch.setattr(cli, "cmd_up", broken)
    with pytest.raises(OSError, match="unrelated startup failure"):
        cli.main(["up"])
