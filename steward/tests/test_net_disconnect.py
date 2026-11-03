"""Deterministic response-transport failures through real, isolated HTTP listeners."""
from __future__ import annotations

import errno
import http.client
import sys
import threading

import pytest

from steward.net import Binary, HttpError, JsonServer, NO_CONTENT, call, fetch


class _FailingWriter:
    def __init__(self, handler, original, error, fail_on):
        self.handler, self.original, self.error, self.fail_on = handler, original, error, fail_on
        self.writes = 0

    def __getattr__(self, name):
        return getattr(self.original, name)

    def write(self, data):
        self.writes += 1
        if self.handler.path == "/disconnect" and self.writes == self.fail_on:
            raise self.error
        return self.original.write(data)


@pytest.fixture
def response_transport(monkeypatch):
    servers = []

    def create(result, error, fail_on):
        errors, executed = [], []
        finished = threading.Event()

        def respond(query, body):
            executed.append(True)
            return result

        server = JsonServer({("GET", "/disconnect"): respond, ("GET", "/health"): lambda q, b: {"ready": True}})
        servers.append(server)
        handler_type = server._httpd.RequestHandlerClass
        setup = handler_type.setup

        def failing_setup(handler):
            setup(handler)
            handler.wfile = _FailingWriter(handler, handler.wfile, error, fail_on)

        original_process = server._httpd.process_request_thread

        def process(request, address):
            try:
                original_process(request, address)
            finally:
                finished.set()

        monkeypatch.setattr(handler_type, "setup", failing_setup)
        monkeypatch.setattr(server._httpd, "process_request_thread", process)
        monkeypatch.setattr(server._httpd, "handle_error", lambda request, address: errors.append(sys.exc_info()[1]))
        server.start()
        return server, errors, executed, finished

    yield create
    for server in servers:
        server.stop()


def _disconnected_get(server):
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
    try:
        connection.request("GET", "/disconnect")
        with pytest.raises((http.client.RemoteDisconnected, http.client.IncompleteRead, ConnectionError)):
            connection.getresponse().read()
    finally:
        connection.close()


def _assert_listener_healthy(server, finished):
    finished.clear()
    assert call("GET", f"{server.url}/health") == {"ready": True}
    assert finished.wait(5), "health request thread did not finish"


@pytest.mark.parametrize("error_type", [BrokenPipeError, ConnectionResetError, ConnectionAbortedError])
@pytest.mark.parametrize("result,fail_on", [({"ok": True}, 2), (Binary(b"pixels", "image/png"), 2),
                                          (NO_CONTENT, 1), ({"ok": True}, 1)])
def test_client_disconnect_ends_only_its_response_without_retrying_the_handler(response_transport, error_type, result, fail_on):
    server, errors, executed, finished = response_transport(result, error_type("client disconnected"), fail_on)
    _disconnected_get(server)
    assert finished.wait(5), "request thread did not finish"
    assert errors == []
    assert len(executed) == 1
    _assert_listener_healthy(server, finished)


def test_unrelated_response_io_errors_still_reach_the_server_error_handler(response_transport):
    failure = OSError(errno.EIO, "unexpected response I/O error")
    server, errors, executed, finished = response_transport({"ok": True}, failure, 2)
    _disconnected_get(server)
    assert finished.wait(5), "request thread did not finish"
    assert errors == [failure]
    assert len(executed) == 1
    _assert_listener_healthy(server, finished)


def test_connection_error_inside_a_route_is_reported_as_a_handler_failure():
    def broken_route(query, body):
        raise ConnectionAbortedError("route dependency aborted")

    server = JsonServer({("GET", "/broken"): broken_route}).start()
    try:
        with pytest.raises(HttpError) as error:
            call("GET", f"{server.url}/broken")
        assert error.value.status == 500
        assert "ConnectionAbortedError: route dependency aborted" in str(error.value)
    finally:
        server.stop()


def test_normal_json_binary_empty_and_error_responses_preserve_their_http_fields():
    server = JsonServer({
        ("GET", "/json"): lambda q, b: {"ok": True},
        ("GET", "/binary"): lambda q, b: Binary(b"pixels", "image/png", {"X-Frame-Stamp": "1.25"}),
        ("GET", "/empty"): lambda q, b: NO_CONTENT,
    }).start()
    try:
        assert call("GET", f"{server.url}/json") == {"ok": True}
        status, data, headers = fetch(f"{server.url}/binary")
        assert (status, data) == (200, b"pixels")
        assert headers["Content-Type"] == "image/png"
        assert headers["Content-Length"] == "6"
        assert headers["X-Frame-Stamp"] == "1.25"
        assert fetch(f"{server.url}/empty")[:2] == (204, b"")
        with pytest.raises(HttpError) as error:
            call("GET", f"{server.url}/missing")
        assert error.value.status == 404
    finally:
        server.stop()
