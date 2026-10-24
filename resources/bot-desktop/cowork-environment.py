#!/usr/bin/env python3
"""Guest-only tool worker. Requests/results are JSON; executable source is never encoded.

Runs inside the selected computer. The host supplies the root and operation identity.
No host credentials, host paths, or container runtime socket are passed to this worker.
"""
import base64
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import signal
import shlex
import socket
import struct
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

LIMIT = 2 * 1024 * 1024

# A readable, guest-only process supervisor. It drains pipes continuously, retains at
# most 100 KiB per stream, and records exit status after cancellation. No executable
# content is base64/hex encoded. Each process has a separate, private state folder.
PROCESS_MONITOR_SOURCE = r"""
import json, os, pathlib, selectors, signal, subprocess, sys, time
c = json.loads(sys.argv[1])
f = pathlib.Path(c['folder'])
def publish(filename, content):
    target = pathlib.Path(filename)
    tmp = target.with_suffix('.tmp')
    tmp.write_text(content)
    tmp.replace(target)
stopping = False
def stop(_sig, _frame):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, stop)
try:
    start = pathlib.Path('/proc', str(os.getpid()), 'stat').read_text().split()[21]
except FileNotFoundError:
    start = None
info = {'pid': os.getpid(), 'start': start}
for name in ('stdout', 'stderr'):
    (f / name).write_bytes(b'')
p = subprocess.Popen(['bash', '-c', c['command']], cwd=c['cwd'], env=c['env'],
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
sel = selectors.DefaultSelector()
sel.register(p.stdout, selectors.EVENT_READ, 'stdout')
sel.register(p.stderr, selectors.EVENT_READ, 'stderr')
publish(f / 'process.json', json.dumps(info))
publish(c['active'], json.dumps(info))
buffers = {'stdout': b'', 'stderr': b''}
truncated = False
deadline = time.monotonic() + c['timeout']
timed_out = False
while sel.get_map() or p.poll() is None:
    if stopping or pathlib.Path(c['cancel']).exists() or time.monotonic() >= deadline:
        timed_out = time.monotonic() >= deadline
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
    events = sel.select(.05) if sel.get_map() else []
    if not sel.get_map(): time.sleep(.05)
    for key, _ in events:
        chunk = os.read(key.fileobj.fileno(), 65536)
        if not chunk:
            sel.unregister(key.fileobj)
            key.fileobj.close()
            continue
        name = key.data
        data = buffers[name] + chunk
        if len(data) > 102400: truncated = True
        buffers[name] = data[-102400:]
        (f / name).write_bytes(buffers[name])
p.wait()
publish(f / 'exit', str(p.returncode))
print(json.dumps({'success': p.returncode == 0 and not timed_out, 'exitCode': p.returncode,
    'stdout': buffers['stdout'].decode('utf-8', 'replace'), 'stderr': buffers['stderr'].decode('utf-8', 'replace'),
    'timedOut': timed_out, 'truncated': truncated}))
"""


def atomic_json(filename, value):
    tmp = filename.with_suffix(".tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    os.replace(tmp, filename)


def dispatch(req):
    root = pathlib.Path(req.get("root", "/home/bot/work")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    identity = req["environment"]
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", identity):
        raise ValueError("Invalid environment identity")
    state = pathlib.Path(tempfile.gettempdir()) / "cowork-environments" / identity
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    tool, args = req["tool"], req.get("input", {})

    def file(value, allow_root=False):
        raw = str(value or ".")
        # Absolute paths are accepted only when they name this guest workspace.
        p = pathlib.Path(raw)
        if not p.is_absolute():
            p = root / p
        if ".." in p.parts:
            raise ValueError("Parent traversal is not allowed")
        relative = p.relative_to(root)
        if any(part in (".git", ".cowork", ".ssh", ".aws") or part == ".env" or part.startswith(".env.") for part in relative.parts):
            raise ValueError("Private path is unavailable")
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("Symlink paths are unavailable")
        if not allow_root and p == root:
            raise ValueError("An individual file path is required")
        return p

    def bounded_read(p):
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > LIMIT:
                raise ValueError("Select a regular file up to 2 MiB")
            data = bytearray()
            while len(data) <= LIMIT:
                block = os.read(fd, min(65536, LIMIT + 1 - len(data)))
                if not block:
                    break
                data.extend(block)
            after = os.fstat(fd)
            if len(data) > LIMIT or before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
                raise ValueError("File changed during bounded read")
            return bytes(data)
        finally:
            os.close(fd)

    def command(command, seconds):
        cwd_file = state / "cwd"
        cwd = file(args.get("cwd") or (cwd_file.read_text().strip() if cwd_file.exists() else str(root)), True)
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "DISPLAY")}
        supplied = args.get("env") or {}
        if not isinstance(supplied, dict) or any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) or not isinstance(v, str) for k, v in supplied.items()):
            raise ValueError("Invalid command environment")
        env.update(supplied)
        wrapped = "trap " + shlex.quote("pwd -P > " + shlex.quote(str(cwd_file))) + " EXIT\n" + command
        folder = state / ("process-" + req["operation"])
        folder.mkdir()
        config = {"command": wrapped, "cwd": str(cwd), "env": env, "folder": str(folder),
                  "timeout": 86400 if args.get("background") else seconds,
                  "active": str(state / ("active-" + req["operation"] + ".json")),
                  "cancel": str(state / ("cancel-" + req["operation"]))}
        if args.get("background"):
            child = subprocess.Popen([sys.executable, "-c", PROCESS_MONITOR_SOURCE, json.dumps(config)],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
            for _ in range(100):
                if (folder / "process.json").exists():
                    break
                if child.poll() is not None:
                    raise ValueError("The background command did not start")
                time.sleep(.01)
            else:
                child.terminate()
                raise ValueError("Background process readiness timed out")
            return {"success": True, "process_id": req["operation"], "status": "running"}
        result = subprocess.run([sys.executable, "-c", PROCESS_MONITOR_SOURCE, json.dumps(config)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=seconds + 15)
        if result.returncode != 0:
            raise ValueError("The guest process monitor failed")
        return json.loads(result.stdout)

    if tool == "receipt":
        op = str(args.get("id", ""))
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", op):
            raise ValueError("Invalid receipt id")
        p = state / (op + ".json")
        return {"found": p.exists(), "result": json.loads(p.read_text()) if p.exists() else None}
    if tool == "cancel_operation":
        op = str(args.get("id", ""))
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", op):
            raise ValueError("Invalid operation id")
        (state / ("cancel-" + op)).touch()
        active = state / ("active-" + op + ".json")
        if active.exists():
            info = json.loads(active.read_text())
            try:
                current = pathlib.Path("/proc", str(info["pid"]), "stat").read_text().split()[21]
                if current == info["start"]:
                    os.kill(info["pid"], signal.SIGTERM)
            except (FileNotFoundError, ProcessLookupError):
                pass
        return {"success": True, "cancellation_requested": True}
    if tool.startswith("desktop_"):
        if tool == "desktop_screenshot":
            with tempfile.TemporaryDirectory() as folder:
                image = pathlib.Path(folder) / "screen.png"
                subprocess.run(["scrot", "--overwrite", str(image)], check=True, timeout=10)
                return {"success": True, "imageBase64": base64.b64encode(bounded_read(image)).decode(), "mediaType": "image/png"}
        if tool == "desktop_open_url":
            return browser("browser_navigate", args, state, root)
        if tool == "desktop_run":
            return command(str(args.get("command", "")), min(300, max(1, int(args.get("timeout_seconds", 60)))))
        argv = ["xdotool"]
        def coordinate(key):
            value = int(args[key])
            if value < 0 or value > 10000:
                raise ValueError("Invalid desktop coordinate")
            return str(value)
        if tool == "desktop_click":
            argv += ["mousemove", "--sync", coordinate("x"), coordinate("y"), "click"]
            if args.get("double"):
                argv += ["--repeat", "2", "--delay", "80"]
            argv += ["3" if args.get("button") == "right" else "2" if args.get("button") == "middle" else "1"]
        elif tool == "desktop_type":
            argv += ["type", "--delay", "12", "--", str(args.get("text", ""))[:4000]]
        elif tool == "desktop_key":
            key = str(args.get("keys", ""))
            if not re.fullmatch(r"[A-Za-z0-9_+-]{1,64}", key):
                raise ValueError("Invalid key chord")
            argv += ["key", "--", key]
        elif tool == "desktop_scroll":
            amount = max(-20, min(20, int(args.get("amount", 0))))
            if amount == 0:
                raise ValueError("Scroll amount must be nonzero")
            argv += ["mousemove", "--sync", coordinate("x"), coordinate("y"), "click", "--repeat", str(abs(amount)), "5" if amount > 0 else "4"]
        elif tool == "desktop_drag":
            argv += ["mousemove", "--sync", coordinate("from_x"), coordinate("from_y"), "mousedown", "1", "mousemove", "--sync", coordinate("to_x"), coordinate("to_y"), "mouseup", "1"]
        else:
            raise ValueError("Unsupported desktop capability")
        subprocess.run(argv, check=True, timeout=60)
        return {"success": True, "note": "Take a fresh desktop screenshot."}
    if tool == "read_file":
        data = bounded_read(file(args.get("path")))
        content = data.decode("utf-8")
        start = max(0, int(args.get("startChar", 0)))
        end = start + min(100000, max(1, int(args.get("maxChars") or 50000)))
        return {"content": content[start:end], "size": len(data), "truncated": end < len(content),
                "nextStartChar": end if end < len(content) else None}
    if tool in ("write_file", "import_file"):
        p = file(args.get("path"))
        data = base64.b64decode(args["data"], validate=True) if tool == "import_file" else str(args["content"]).encode()
        if len(data) > LIMIT:
            raise ValueError("File exceeds 2 MiB limit")
        p.parent.mkdir(parents=True, exist_ok=True)
        if tool == "import_file" and p.exists():
            previous = bounded_read(p)
            if previous == data:
                return {"success": True, "path": str(p.relative_to(root)), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            raise ValueError("Input destination already contains different guest data; it was retained")
        with p.open("xb" if tool == "import_file" else "wb") as stream:
            stream.write(data)
        return {"success": True, "path": str(p.relative_to(root)), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if tool == "export_file":
        data = bounded_read(file(args.get("path")))
        return {"data": base64.b64encode(data).decode(), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if tool == "edit_file":
        p = file(args.get("path", args.get("file_path")))
        content = bounded_read(p).decode("utf-8")
        old = args.get("old_string", args.get("oldText"))
        new = args.get("new_string", args.get("newText"))
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise ValueError("old_string and new_string are required")
        count = content.count(old)
        if count == 0 or (count > 1 and not args.get("replace_all")):
            raise ValueError("Edit must match exactly once, or specify replace_all")
        content = content.replace(old, new, -1 if args.get("replace_all") else 1)
        if len(content.encode()) > LIMIT:
            raise ValueError("Edited file exceeds limit")
        p.write_text(content, encoding="utf-8")
        return {"success": True, "replacements": count if args.get("replace_all") else 1}
    if tool in ("list_directory", "list_directory_with_sizes"):
        entries = []
        for p in sorted(file(args.get("path"), True).iterdir()):
            if len(entries) >= 1000:
                break
            try:
                p = file(str(p))
                entries.append({"name": p.name, "type": "directory" if p.is_dir() else "file", "size": p.stat().st_size})
            except ValueError:
                continue
        return {"entries": entries}
    if tool == "create_directory":
        file(args.get("path")).mkdir(parents=True, exist_ok=True)
        return {"success": True}
    if tool == "delete_file":
        file(args.get("path")).unlink()
        return {"success": True}
    if tool in ("rename_file", "copy_file"):
        src = file(args.get("sourcePath", args.get("oldPath")))
        dst = file(args.get("destPath", args.get("newPath")))
        with dst.open("xb") as stream:
            stream.write(bounded_read(src))
        if tool == "rename_file":
            src.unlink()
        return {"success": True}
    if tool == "get_file_info":
        p = file(args.get("path"))
        file_stat = p.stat()
        return {"path": str(p.relative_to(root)), "size": file_stat.st_size, "modified": file_stat.st_mtime * 1000, "isDirectory": p.is_dir()}
    if tool in ("glob", "grep", "search_files", "read_files"):
        base = file(args.get("path"), True)
        patterns = args.get("patterns", [args.get("pattern", "**/*")]) if tool == "read_files" else [args.get("pattern", "**/*") if tool == "glob" else "**/*"]
        if not isinstance(patterns, list) or not patterns or len(patterns) > 64:
            raise ValueError("A bounded list of patterns is required")
        if any(not isinstance(p, str) or ".." in p.split("/") or p.startswith("/") for p in patterns):
            raise ValueError("Invalid search pattern")
        include = [p for p in patterns if not p.startswith("!")]
        exclude = [p[1:] for p in patterns if p.startswith("!")]
        def matches(name, pattern):
            brace = re.search(r"\{([^{}]+)\}", pattern)
            if brace:
                return any(matches(name, pattern[:brace.start()] + choice + pattern[brace.end():]) for choice in brace.group(1).split(",")[:20])
            return fnmatch.fnmatchcase(name, pattern) or (pattern.startswith("**/") and fnmatch.fnmatchcase(name, pattern[3:]))
        maximum = min(200, max(1, int(args.get("maxResults", 100))))
        if tool == "read_files":
            maximum = min(100, max(1, int(args.get("maxFiles", 12))))
        max_chars = min(100000, max(1000, int(args.get("maxTotalChars", 30000))))
        results, scanned, chars = [], 0, 0
        needle = str(args.get("pattern", args.get("query", "")))
        if len(needle) > 4096:
            raise ValueError("Search expression exceeds limit")
        regex = re.compile(needle, re.IGNORECASE if args.get("ignoreCase") else 0) if tool == "grep" else None
        truncated = False
        files_searched = 0
        for directory, dirs, names in os.walk(base, followlinks=False):
            dirs[:] = [d for d in dirs if not d.startswith(".") and not pathlib.Path(directory, d).is_symlink()]
            for name in sorted(names):
                scanned += 1
                if scanned > 10000 or len(results) >= maximum or chars >= max_chars:
                    truncated = True
                    break
                p = pathlib.Path(directory, name)
                try:
                    p = file(str(p))
                    relative = str(p.relative_to(base))
                    if any(matches(relative, pattern) for pattern in exclude):
                        continue
                    if tool == "search_files":
                        if needle.lower() in name.lower():
                            results.append({"name": name, "path": str(p.relative_to(root)), "type": "file"})
                    elif tool == "grep":
                        if args.get("glob") and not matches(relative, args["glob"]):
                            continue
                        lines = bounded_read(p).decode("utf-8", "replace").splitlines()
                        files_searched += 1
                        found = [(number, line) for number, line in enumerate(lines, 1) if regex.search(line)]
                        mode = args.get("outputMode", "content")
                        if found and mode in ("count", "files_only"):
                            results.append({"file": str(p.relative_to(root)), **({"count": len(found)} if mode == "count" else {})})
                        elif found:
                            for number, line in found:
                                if len(results) >= maximum:
                                    truncated = True
                                    break
                                context = max(0, min(10, int(args.get("contextLines", 0))))
                                results.append({"file": str(p.relative_to(root)), "line": number, "content": line[:1000],
                                    "context": {"before": lines[max(0, number - context - 1):number - 1], "after": lines[number:number + context]}})
                    elif any(matches(relative, pattern) for pattern in include):
                        if tool == "read_files":
                            content = bounded_read(p).decode("utf-8")
                            window = content[:max_chars - chars]
                            chars += len(window)
                            results.append({"path": str(p.relative_to(root)), "content": window, "size": p.stat().st_size, "truncated": len(window) < len(content)})
                        else:
                            results.append({"path": str(p.relative_to(root)), "size": p.stat().st_size, "modified": p.stat().st_mtime * 1000})
                except (ValueError, OSError, UnicodeError):
                    continue
            if truncated:
                break
        if tool == "read_files":
            return {"success": True, "basePath": str(base), "files": results, "included": len(results), "totalMatched": len(results), "truncated": truncated}
        return {"success": True, "pattern": needle, "matches": results, "totalMatches": len(results), "filesSearched": files_searched, "truncated": truncated}
    if tool in ("run_command", "execute_code"):
        seconds = min(300, max(1, float(args.get("timeout_seconds", 60))))
        cmd = args.get("command", "")
        if tool == "execute_code":
            language = args.get("language")
            if language not in ("python", "javascript", "shell"):
                raise ValueError("Unsupported code language")
            if language == "shell":
                cmd = args["code"]
            else:
                script = state / ("script.py" if language == "python" else "script.js")
                script.write_text(args["code"], encoding="utf-8")
                cmd = ("python3 " if language == "python" else "node ") + shlex.quote(str(script))
        if not isinstance(cmd, str) or not cmd or len(cmd) > 100000:
            raise ValueError("A command is required (maximum 100000 characters)")
        result = command(cmd, seconds)
        if tool == "execute_code":
            result.update({"exit_code": result["exitCode"], "timed_out": result["timedOut"], "language": args["language"], "output_truncated": result["truncated"]})
        return result
    if tool in ("process_output", "stop_process"):
        proc_id = str(args.get("process_id", ""))
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", proc_id):
            raise ValueError("A process_id from this environment is required")
        folder = state / ("process-" + proc_id)
        info = json.loads((folder / "process.json").read_text())
        if tool == "stop_process" and not (folder / "exit").exists():
            (state / ("cancel-" + proc_id)).touch()
            try:
                current = pathlib.Path("/proc", str(info["pid"]), "stat").read_text().split()[21]
                if current == info.get("start"):
                    os.kill(info["pid"], signal.SIGTERM)
            except (ProcessLookupError, FileNotFoundError):
                pass
            for _ in range(100):
                if (folder / "exit").exists():
                    break
                time.sleep(.02)
        done = (folder / "exit").exists()
        return {"success": True, "process_id": proc_id, "status": "completed" if done else "running",
                "exitCode": int((folder / "exit").read_text()) if done else None,
                "stdout": bounded_read(folder / "stdout")[-102400:].decode("utf-8", "replace"),
                "stderr": bounded_read(folder / "stderr")[-102400:].decode("utf-8", "replace")}
    if tool.startswith("browser_"):
        return browser(tool, args, state, root)
    raise ValueError("This tool is not supported in the selected computer: " + tool)


def browser(tool, args, state, root):
    """Bounded CDP connection to Chromium's guest-loopback-only debugging port."""
    base = "http://127.0.0.1:9222"

    def http(route, method="GET"):
        with urllib.request.urlopen(urllib.request.Request(base + route, method=method), timeout=10) as response:
            data = response.read()
            try:
                return json.loads(data)
            except ValueError:
                return {"text": data.decode("utf-8", "replace")}

    try:
        tabs = [t for t in http("/json/list") if t.get("type") == "page"]
    except OSError:
        log = (state / "chromium.log").open("ab")
        subprocess.Popen(["chromium", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
                          "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9222",
                          "--user-data-dir=" + str(root / ".browser"), "about:blank"], stdout=log, stderr=log, start_new_session=True)
        log.close()
        for _ in range(50):
            try:
                tabs = [t for t in http("/json/list") if t.get("type") == "page"]
                break
            except OSError:
                time.sleep(.1)
        else:
            raise ValueError("The guest browser could not start")
    selected = state / "browser-tab"
    active = selected.read_text() if selected.exists() else ""
    tab = next((t for t in tabs if t["id"] == active), tabs[0] if tabs else None)
    if tool == "browser_tabs":
        return {"tabs": [{"id": t["id"], "title": t["title"], "url": t["url"], "active": t == tab} for t in tabs]}
    if tool in ("browser_switch_tab", "browser_close_tab"):
        target = next((t for t in tabs if t["id"] == args.get("tab_id")), None)
        if not target:
            raise ValueError("Tab does not belong to this computer")
        if tool == "browser_close_tab":
            if len(tabs) <= 1:
                raise ValueError("Cannot close the final tab")
            http("/json/close/" + target["id"])
        else:
            selected.write_text(target["id"])
            http("/json/activate/" + target["id"])
        return {"success": True}
    if not tab:
        raise ValueError("No browser tab is available")
    selected.write_text(tab["id"])
    url = urllib.parse.urlparse(tab["webSocketDebuggerUrl"])
    if url.hostname not in ("127.0.0.1", "localhost") or url.port != 9222:
        raise ValueError("Unexpected browser debugger endpoint")
    sock = socket.create_connection(("127.0.0.1", 9222), timeout=15)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(("GET " + url.path + " HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())

    def exact(n):
        result = b""
        while len(result) < n:
            block = sock.recv(n - len(result))
            if not block:
                raise ValueError("Browser connection closed")
            result += block
        return result

    header = b""
    while not header.endswith(b"\r\n\r\n") and len(header) < 8192:
        header += exact(1)
    if not header.startswith(b"HTTP/1.1 101"):
        sock.close()
        raise ValueError("Browser refused its debugging connection")
    sequence = 0

    def call(method, params=None):
        nonlocal sequence
        sequence += 1
        data = json.dumps({"id": sequence, "method": method, "params": params or {}}).encode()
        mask = os.urandom(4)
        length = len(data)
        frame = bytes([0x81, 0x80 | length]) if length < 126 else bytes([0x81, 0xfe]) + struct.pack("!H", length) if length < 65536 else bytes([0x81, 0xff]) + struct.pack("!Q", length)
        sock.sendall(frame + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(data)))
        for _ in range(500):
            first, second = exact(2)
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", exact(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", exact(8))[0]
            if size > 8 * 1024 * 1024 or second & 128 or first & 15 != 1 or not first & 128:
                raise ValueError("Unsupported browser response frame")
            response = json.loads(exact(size))
            if response.get("id") == sequence:
                if "error" in response:
                    raise ValueError(response["error"].get("message", "Browser command failed"))
                return response.get("result", {})
        raise ValueError("Browser response limit reached")

    def evaluate(script):
        response = call("Runtime.evaluate", {"expression": script, "returnByValue": True, "awaitPromise": True})
        if response.get("exceptionDetails"):
            raise ValueError("Browser script failed")
        return response.get("result", {}).get("value")

    try:
        if tool == "browser_navigate":
            dest = str(args.get("url", ""))
            if urllib.parse.urlparse(dest).scheme not in ("http", "https"):
                raise ValueError("Only http and https navigation is supported")
            result = call("Page.navigate", {"url": dest})
            if result.get("errorText"):
                raise ValueError(result["errorText"])
            time.sleep(.3)
            return {"success": True, "url": dest, "tab_id": tab["id"]}
        if tool == "browser_screenshot":
            result = call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": bool(args.get("full_page"))})
            return {"success": True, "imageBase64": result["data"], "mediaType": "image/png"}
        if tool == "browser_snapshot":
            # Refs live only in this document. Navigation destroys them; each snapshot replaces them.
            token = os.urandom(6).hex()
            script = """(() => {const token=TOKEN;window.__coworkRefs={};let n=0;const nodes=[];for(const e of document.querySelectorAll('a,button,input,select,textarea,[role],[tabindex]')){if(!e.getClientRects().length)continue;const ref=token+'-'+(++n);window.__coworkRefs[ref]=e;nodes.push({ref,role:e.getAttribute('role')||e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||'').slice(0,300)});if(n>=400)break;}return {url:location.href,title:document.title,nodes,text:document.body.innerText.slice(0,20000)};})()""".replace("TOKEN", json.dumps(token))
            return evaluate(script)
        if tool in ("browser_get_text", "browser_get_content"):
            selector = args.get("selector")
            expression = "document.querySelector(" + json.dumps(selector) + ")" if selector else "document.body"
            return {"content": evaluate("(" + expression + ")?.innerText?.slice(0,50000)")}
        if tool == "browser_evaluate":
            script = str(args.get("script", ""))
            if len(script) > 50000:
                raise ValueError("Script exceeds limit")
            return {"result": evaluate(script)}
        if tool in ("browser_click", "browser_fill", "browser_type"):
            ref, selector = args.get("ref"), args.get("selector")
            element = "window.__coworkRefs?.[" + json.dumps(ref) + "]" if ref else "document.querySelector(" + json.dumps(selector) + ")"
            setup = "const e=" + element + ";if(!e||!e.isConnected)throw Error('Missing or stale reference');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden element');const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(hit!==e&&!e.contains(hit))throw Error('Element is covered');"
            if tool == "browser_click":
                coords = evaluate("(()=>{" + setup + "return {x:r.x+r.width/2,y:r.y+r.height/2};})()")
                call("Input.dispatchMouseEvent", {"type": "mousePressed", **coords, "button": "left", "clickCount": 1})
                call("Input.dispatchMouseEvent", {"type": "mouseReleased", **coords, "button": "left", "clickCount": 1})
            else:
                evaluate("(()=>{" + setup + "e.focus();" + ("e.select();" if tool == "browser_fill" else "") + "})()")
                call("Input.insertText", {"text": str(args.get("text", args.get("value", "")))[:50000]})
            return {"success": True, "note": "Take a new snapshot before the next action."}
        if tool == "browser_press":
            keys = {"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "ArrowDown": 40, "ArrowUp": 38}
            key = args.get("key")
            if key not in keys:
                raise ValueError("Unsupported key in this browser backend")
            for kind in ("keyDown", "keyUp"):
                call("Input.dispatchKeyEvent", {"type": kind, "key": key, "windowsVirtualKeyCode": keys[key]})
            return {"success": True}
        if tool in ("browser_back", "browser_forward", "browser_reload", "browser_scroll"):
            script = "location.reload()" if tool == "browser_reload" else "history.back()" if tool == "browser_back" else "history.forward()" if tool == "browser_forward" else "scrollBy(0," + str(max(-5000, min(5000, int(args.get("amount", 600))))) + ")"
            evaluate(script)
            return {"success": True}
        if tool == "browser_wait":
            for _ in range(50):
                if evaluate("Boolean(document.querySelector(" + json.dumps(args.get("selector")) + "))"):
                    return {"success": True}
                time.sleep(.1)
            raise ValueError("Element did not appear")
        raise ValueError("Unsupported browser capability")
    finally:
        sock.close()


def main():
    req = json.loads(sys.stdin.read(LIMIT * 2))
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", str(req.get("environment", ""))) or (req.get("operation") and not re.fullmatch(r"[a-zA-Z0-9-]{1,100}", str(req["operation"]))):
        raise ValueError("Invalid request identity")
    try:
        result = dispatch(req)
    except Exception as error:
        result = {"success": False, "error": str(error)[:1000]}
    # Completion receipt enables readback after a lost transport response. It is guest evidence,
    # not independent verification of an arbitrary external effect performed by a command.
    if req.get("operation") and req["tool"] != "receipt":
        state = pathlib.Path(tempfile.gettempdir()) / "cowork-environments" / req["environment"]
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        atomic_json(state / (req["operation"] + ".json"), result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
