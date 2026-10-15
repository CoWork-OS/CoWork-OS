"""Exercise the shipped worker with a deterministic phone transport, never ADB."""
import base64
import contextlib
import importlib.metadata
import io
import json
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import types
import zlib

test = json.load(sys.stdin)
importlib.metadata.version = lambda _: "0.3.2"
root = Path(tempfile.mkdtemp(prefix="cowork-phone-bridge-test-"))
state = {"patch": None, "pixel": 0, "xml": '<hierarchy><node password="false"/></hierarchy>', "busy": False, "actions": []}


def png(value):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    pixels = bytearray([value]) * (100 * 100 * 3)
    if state["patch"]:
        x1, y1, x2, y2 = state["patch"]
        for y in range(y1, y2):
            for x in range(x1, x2):
                start = (y * 100 + x) * 3
                pixels[start:start + 3] = bytes([255, 255, 255])
    rows = b"".join(b"\0" + pixels[y*300:(y+1)*300] for y in range(100))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 100, 100, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


class Android:
    def __init__(self, serial):
        pass

    def _screen_status(self):
        return True, False

    def _adb(self, *args, **kwargs):
        return state["xml"].encode()

    def send(self, operation, **kwargs):
        if operation == "tree":
            if state["busy"]:
                raise RuntimeError("TreeUnavailable: could not get idle state")
            return [dict(text="", desc="", id="web", **{"class": "android.webkit.WebView"},
                         clickable=True, x=50, y=50, w=100, h=100)]
        if operation == "apps.current":
            return "test.app"
        if operation == "screen.bounds":
            return {"width": 100, "height": 100}
        if operation == "screen.capture":
            Path(kwargs["path"]).write_bytes(png(state["pixel"]))
            return
        state["actions"].append(operation)


sys.modules["phone_harness"] = types.ModuleType("phone_harness")
module = types.ModuleType("phone_harness.android")
module.Android = Android
sys.modules["phone_harness.android"] = module


def run(extra):
    request = dict(deviceId="selected", adbPath="adb", root=str(root), **extra)
    previous = sys.stdin
    sys.stdin = io.StringIO(json.dumps(request))
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output):
            exec(test["bridge"], {})
    finally:
        sys.stdin = previous
    return json.loads(output.getvalue())


try:
    case = test["case"]
    if case.startswith("typing_") or case == "tap_caret_change":
        if case != "typing_opaque_change":
            state["xml"] = '<hierarchy><node password="false" focused="true" enabled="true" package="test.app" class="android.widget.EditText" resource-id="input" text="" bounds="[10,10][90,40]"/></hierarchy>'
    original = run({"mode": "observe"})["observation"]
    if case in ("changed_pixels", "home_changed_pixels"):
        state["pixel"] = 255
    elif case == "xml_error":
        state["xml"] = "ERROR: could not get idle state"
    elif case == "xml_malformed":
        state["xml"] = '<hierarchy><node password="false"></hierarchy>'
    elif case == "xml_missing_attribute":
        state["xml"] = "<hierarchy><node/></hierarchy>"
    elif case == "password":
        state["xml"] = '<hierarchy><node password="true"/></hierarchy>'
    elif case == "busy":
        state["busy"] = True
    if case in ("typing_caret", "tap_caret_change"):
        state["patch"] = (20, 15, 22, 28)
    elif case == "typing_surrounding_change":
        state["patch"] = (5, 50, 20, 70)
    elif case == "typing_target_change":
        state["xml"] = state["xml"].replace('resource-id="input"', 'resource-id="other"')
    elif case == "typing_focus_lost":
        state["xml"] = state["xml"].replace('focused="true"', 'focused="false"')
    elif case == "typing_text_changed":
        state["xml"] = state["xml"].replace('text=""', 'text="new value"')
    elif case == "typing_opaque_change":
        state["pixel"] = 255
    current = run({"mode": "observe"})
    action = {"kind": "type_text", "text": "example text"} if case.startswith(("xml_", "typing_")) else {"kind": "tap", "x": 50, "y": 50}
    if case == "home_changed_pixels":
        action = {"kind": "home"}
    applied = run(dict(mode="action", operationId="test-operation",
                       snapshotId="11111111-1111-4111-8111-111111111111",
                       requestDigest="test-request", stateDigest=original["stateDigest"], typingDigest=original.get("typingDigest"), action=action))
    print(json.dumps(dict(observation=current.get("observation"), result=applied,
                          inputCalls=state["actions"], receiptExists=(root / "test-operation.json").exists())))
finally:
    shutil.rmtree(root)
