#!/usr/bin/env python3
"""Records what the person does on the bot's desktop, and plays it back exactly.

  cowork-teach record   Start recording keys, clicks and pointer moves (runs until stopped).
  cowork-teach stop     Stop recording; print the recording (JSON lines) and delete it here.
  cowork-teach cancel   Stop recording and delete it.
  cowork-teach status   Print "recording" or "idle".
  cowork-teach play     Play a recording read from stdin.

CoWork keeps recordings in its own app data, not on this desktop: `stop` hands the recording
over and deletes it, and `play` reads it from stdin, so the bot's own commands never find what
the person typed.
"""

import json
import os
import signal
import sys
import time

from Xlib import X, display
from Xlib.ext import record, xtest
from Xlib.protocol import rq

STATE_DIR = "/tmp/cowork-teach"
RECORDING = os.path.join(STATE_DIR, "recording.jsonl")
PID_FILE = os.path.join(STATE_DIR, "pid")
# A recording ends on its own after this long or this many events.
MAX_SECONDS = 10 * 60
MAX_EVENTS = 50_000
# Pointer moves closer together than this are not all kept.
MOVE_SPACING_MS = 15
# A pause longer than this during playback is shortened to it.
MAX_PAUSE_MS = 10_000

EVENT_KINDS = {
    X.KeyPress: ("key", 1),
    X.KeyRelease: ("key", 0),
    X.ButtonPress: ("button", 1),
    X.ButtonRelease: ("button", 0),
    X.MotionNotify: ("move", 0),
}


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


def recording_pid():
    try:
        with open(PID_FILE) as handle:
            pid = int(handle.read().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def record_events():
    if recording_pid():
        fail("A recording is already running.", 2)
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    os.umask(0o077)
    with open(PID_FILE, "w") as handle:
        handle.write(str(os.getpid()))
    out = open(RECORDING, "w")
    data_display = display.Display()
    control_display = display.Display()
    context = data_display.record_create_context(
        0,
        [record.AllClients],
        [
            {
                "core_requests": (0, 0),
                "core_replies": (0, 0),
                "ext_requests": (0, 0, 0, 0),
                "ext_replies": (0, 0, 0, 0),
                "delivered_events": (0, 0),
                "device_events": (X.KeyPress, X.MotionNotify),
                "errors": (0, 0),
                "client_started": False,
                "client_died": False,
            }
        ],
    )
    state = {"start": None, "count": 0, "last_move": -MOVE_SPACING_MS, "stopped": False}

    def stop(*_):
        if state["stopped"]:
            return
        state["stopped"] = True
        control_display.record_disable_context(context)
        control_display.flush()

    def on_reply(reply):
        if reply.category != record.FromServer or reply.client_swapped:
            return
        data = reply.data
        while data:
            event, data = rq.EventField(None).parse_binary_value(
                data, data_display.display, None, None
            )
            kind = EVENT_KINDS.get(event.type)
            if not kind:
                continue
            if state["start"] is None:
                state["start"] = event.time
            t = (event.time - state["start"]) & 0xFFFFFFFF
            if kind[0] == "move":
                if t - state["last_move"] < MOVE_SPACING_MS:
                    continue
                state["last_move"] = t
            out.write(
                json.dumps(
                    {"t": t, "e": kind[0], "down": kind[1], "d": event.detail,
                     "x": event.root_x, "y": event.root_y},
                    separators=(",", ":"),
                )
                + "\n"
            )
            state["count"] += 1
            if state["count"] >= MAX_EVENTS or t >= MAX_SECONDS * 1000:
                stop()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(MAX_SECONDS + 5)
    try:
        data_display.record_enable_context(context, on_reply)
    finally:
        out.close()
        data_display.record_free_context(context)
        try:
            os.remove(PID_FILE)
        except OSError:
            pass


def stop_recording(keep):
    pid = recording_pid()
    if pid:
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and recording_pid():
            time.sleep(0.05)
    if not os.path.exists(RECORDING):
        fail("No recording is running.", 3)
    try:
        if keep:
            with open(RECORDING) as handle:
                sys.stdout.write(handle.read())
    finally:
        os.remove(RECORDING)


def read_events(stream):
    events = []
    for number, line in enumerate(stream, 1):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
            kind = event["e"]
            values = [int(event[key]) for key in ("t", "down", "d", "x", "y")]
        except (ValueError, KeyError, TypeError):
            fail(f"Line {number} of the recording is not an event.")
        t, down, detail, x, y = values
        if (
            kind not in ("key", "button", "move")
            or not 0 <= t <= MAX_SECONDS * 1000 + 60_000
            or down not in (0, 1)
            or not 0 <= detail <= 255
            or not (0 <= x <= 10_000 and 0 <= y <= 10_000)
        ):
            fail(f"Line {number} of the recording is out of range.")
        events.append((t, kind, down, detail, x, y))
        if len(events) > MAX_EVENTS:
            fail("The recording is too long.")
    return events


def play():
    events = read_events(sys.stdin)
    screen = display.Display()
    held_keys, held_buttons = set(), set()

    def release_all(*_):
        # Nothing stays pressed, whether playback ends, fails or is stopped.
        for key in list(held_keys):
            xtest.fake_input(screen, X.KeyRelease, key)
        for button in list(held_buttons):
            xtest.fake_input(screen, X.ButtonRelease, button)
        screen.sync()

    def on_signal(*_):
        release_all()
        sys.exit(130)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    started = time.monotonic()
    offset = 0
    previous = 0
    try:
        for t, kind, down, detail, x, y in events:
            # Long pauses (the person thinking) are shortened; everything else keeps its timing.
            offset += max(0, (t - previous) - MAX_PAUSE_MS)
            previous = t
            wait = (t - offset) / 1000 - (time.monotonic() - started)
            if wait > 0:
                time.sleep(wait)
            if kind == "move":
                xtest.fake_input(screen, X.MotionNotify, x=x, y=y)
            elif kind == "button":
                xtest.fake_input(screen, X.MotionNotify, x=x, y=y)
                xtest.fake_input(screen, X.ButtonPress if down else X.ButtonRelease, detail)
                (held_buttons.add if down else held_buttons.discard)(detail)
            else:
                xtest.fake_input(screen, X.KeyPress if down else X.KeyRelease, detail)
                (held_keys.add if down else held_keys.discard)(detail)
            screen.sync()
    finally:
        release_all()
    print(f"Played {len(events)} events in {time.monotonic() - started:.1f} s.")


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "record":
        record_events()
    elif command == "stop":
        stop_recording(keep=True)
    elif command == "cancel":
        stop_recording(keep=False)
    elif command == "status":
        print("recording" if recording_pid() else "idle")
    elif command == "play":
        play()
    else:
        fail(__doc__.strip(), 64)


if __name__ == "__main__":
    main()
