"""Verify two local Firefox packages in a fresh profile, without a browser account."""
import argparse
from contextlib import ExitStack, closing, suppress
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlencode
from zipfile import ZipFile, ZIP_DEFLATED

ADDON = "velostream@srikarthickeyanganapathy.github.io"
PROBE = Path(__file__).parent / "fixtures" / "upgrade-check.js"


def instrument(source, destination, options):
    """Add fixed test probes to temporary copies. Keep the installed ID and version."""
    with ZipFile(source) as src, ZipFile(destination, "w", ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item)
            if item.filename == "player/player.html":
                tag = f'<script type="module" src="upgrade-check.js?{urlencode(options)}"></script>'
                data = data.replace(b"</body>", tag.encode() + b"</body>")
            if item.filename == "background/engine.js":
                data += b"\nbrowser.tabs.create({url:browser.runtime.getURL('player/player.html#upgrade-check')});\n"
            dst.writestr(item, data)
        dst.write(PROBE, "player/upgrade-check.js")


def packet(reader):
    size = bytearray()
    while (char := reader.read(1)) != b":":
        if not char or not char.isdigit():
            raise RuntimeError("Invalid Firefox automation response")
        size.extend(char)
    return json.loads(reader.read(int(size)))


def verify(binary, baseline, candidate, sync):
    nonce = "/" + secrets.token_hex(24)
    results = []

    class ResultHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != nonce:
                self.send_error(404)
                return
            size = int(self.headers["Content-Length"])
            if size > 4096:
                self.send_error(413)
                return
            results.append(json.loads(self.rfile.read(size)))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *_):
            pass

    with tempfile.TemporaryDirectory(prefix="aethvyr-") as work, HTTPServer(("127.0.0.1", 0), ResultHandler) as server:
        server.timeout = 1
        profile = Path(work, "profile")
        profile.mkdir()
        with closing(socket.socket()) as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        (profile / "user.js").write_text(f'user_pref("marionette.port", {port});\n', encoding="utf8")
        process = subprocess.Popen([binary, "-headless", "-no-remote", "-profile", str(profile), "-marionette"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    connection = socket.create_connection(("127.0.0.1", port), timeout=20)
                    break
                except ConnectionRefusedError:
                    if process.poll() is not None or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.1)
            with connection, connection.makefile("rb") as reader, ExitStack() as cleanup:
                assert packet(reader)["marionetteProtocol"] == 3
                sequence = 0

                def command(method, params):
                    nonlocal sequence
                    sequence += 1
                    body = json.dumps([0, sequence, method, params]).encode()
                    connection.sendall(str(len(body)).encode() + b":" + body)
                    _, number, error, result = packet(reader)
                    if error or number != sequence:
                        raise RuntimeError(f"{method}: {error}")
                    return result

                session = command("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})

                def shutdown():
                    with suppress(OSError, RuntimeError, subprocess.TimeoutExpired):
                        command("Marionette:Quit", {"flags": ["eAttemptQuit"]})
                        process.wait(timeout=15)

                cleanup.callback(shutdown)
                print(f'Firefox {session["capabilities"]["browserVersion"]}, sync {sync}', flush=True)
                for stage, source, expected in [
                    ("seed", baseline, "seeded"), ("verify", candidate, "upgrade-verified"),
                    ("repeat", candidate, "repeat-upgrade-and-private-history-verified")
                ]:
                    package = Path(work, stage + ".xpi")
                    instrument(source, package, {"stage": stage, "sync": sync,
                               "result": f"http://127.0.0.1:{server.server_port}{nonce}"})
                    installed = command("Addon:Install", {"path": str(package), "temporary": True, "allowPrivateBrowsing": True})
                    assert installed["value"] == ADDON
                    deadline = time.monotonic() + 25
                    while not results and time.monotonic() < deadline:
                        server.handle_request()
                    if not results:
                        raise RuntimeError(f"No result for {stage}")
                    result = results.pop(0)
                    if result.get("value") != expected:
                        raise RuntimeError(f"{stage}: {result}")
                    print(expected, flush=True)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--firefox", default="firefox")
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    for setting in ("off", "on"):
        verify(args.firefox, args.baseline, args.candidate, setting)
