/** Trusted program, never model-supplied Python. All parameters arrive as JSON on stdin. */
export const ANDROID_BRIDGE = String.raw`
import sys, os, json, time, hashlib, base64, tempfile, re
import xml.etree.ElementTree as ET
import io
from pathlib import Path
from importlib.metadata import version
_dispatched = False

def write_json(path, value):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def main():
    global _dispatched
    req = json.load(sys.stdin)
    if version('phone-harness') != '0.3.2': raise RuntimeError('Install the pinned phone-harness 0.3.2 runtime')
    serial = req['deviceId']
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', serial): raise ValueError('Invalid device identity')
    os.environ['ANDROID_SERIAL'] = serial
    os.environ['PHONE_HARNESS_ADB'] = req['adbPath']
    os.environ['PHONE_HARNESS_TELEMETRY'] = '0'
    from phone_harness.android import Android
    phone = Android(serial=serial)  # explicit selection; never transport.connect/cloud/default selection
    root = Path(req['root'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(root / (hashlib.sha256(serial.encode()).hexdigest() + '.lock'), 'a+b')
    if os.name == 'nt':
        import msvcrt
        lock.seek(0); lock.write(b'0'); lock.flush(); lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    awake, locked = phone._screen_status()
    if not awake or locked: raise RuntimeError('Unlock and wake the selected Android phone yourself, then observe again')

    def observe():
        nodes, tree_available, security_known, secure = [], False, False, False
        focused_editors = []
        warnings = []
        try:
            nodes = phone.send('tree')
            tree_available = True
        except Exception:
            warnings.append('Accessibility tree unavailable; screenshot-only observation, user handoff required for input')
        safe = [{k: n.get(k) for k in ('text', 'desc', 'id', 'class', 'clickable', 'x', 'y', 'w', 'h')}
                for n in nodes if not n.get('password')]
        package = phone.send('apps.current')
        bounds = phone.send('screen.bounds')
        # Upstream strips password attributes. An error string or malformed XML is
        # unknown security state, never evidence that the screen is safe for input.
        try:
            raw_xml = phone._adb('exec-out', 'uiautomator', 'dump', '/dev/tty', binary=True, timeout=30).decode('utf-8')
            start, end = raw_xml.find('<hierarchy'), raw_xml.rfind('</hierarchy>')
            if start < 0 or end < start: raise ValueError('No hierarchy XML')
            hierarchy = ET.fromstring(raw_xml[start:end + len('</hierarchy>')])
            xml_nodes = list(hierarchy.iter('node'))
            security_known = bool(xml_nodes) and all(n.get('password') in ('true', 'false') for n in xml_nodes)
            secure = any(n.get('password') == 'true' for n in xml_nodes)
            focused_editors = [(i, dict(n.attrib)) for i, n in enumerate(xml_nodes)
                if n.get('focused') == 'true' and n.get('enabled') == 'true'
                and n.get('password') == 'false' and n.get('package') == package
                and n.get('class') in ('android.widget.EditText', 'android.widget.AutoCompleteTextView', 'android.widget.MultiAutoCompleteTextView')]

        except Exception:
            pass
        if not security_known:
            warnings.append('Secure-field status unavailable; user handoff required for input')
        fd, shot = tempfile.mkstemp(suffix='.png', dir=str(root)); os.close(fd)
        try:
            phone.send('screen.capture', path=shot)
            raw = Path(shot).read_bytes()
            if len(raw) > 12 * 1024 * 1024 or raw[:8] != b'\x89PNG\r\n\x1a\n': raise RuntimeError('Invalid phone screenshot')
            import struct
            width, height = struct.unpack('>II', raw[16:24])
            image_digest = hashlib.sha256(raw).hexdigest()
            digest = hashlib.sha256(json.dumps([package, bounds, safe, focused_editors, image_digest, tree_available, security_known], sort_keys=True).encode()).hexdigest()
            typing_digest = None
            focused_editor = None
            if security_known and tree_available and not secure and len(focused_editors) == 1:
                # Native editable fields expose text/focus/identity/bounds in XML.
                # Ignore only their paint (e.g. blinking caret) for typing, while
                # binding every pixel OUTSIDE that exact field and all its attributes.
                field = focused_editors[0][1]
                box = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', field.get('bounds', ''))
                if box:
                    x1, y1, x2, y2 = map(int, box.groups())
                    if 0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height:
                        from PIL import Image, ImageDraw
                        with Image.open(io.BytesIO(raw)) as source:
                            pixels = source.convert('RGB')
                        ImageDraw.Draw(pixels).rectangle((x1, y1, x2-1, y2-1), fill=(0, 0, 0))
                        masked_hash = hashlib.sha256(pixels.tobytes()).hexdigest()
                        typing_digest = hashlib.sha256(json.dumps([package, bounds, safe, focused_editors, masked_hash], sort_keys=True).encode()).hexdigest()
                        focused_editor = dict(id=field.get('resource-id', '')[:256], text=field.get('text', '')[:512], x=x1, y=y1, w=x2-x1, h=y2-y1)

            return dict(deviceId=serial, createdAt=int(time.time()*1000), width=width, height=height,
                        package=package, stateDigest=digest, typingDigest=typing_digest, texts=[] if secure or not security_known else [str(n.get('text') or n.get('desc'))[:512] for n in safe if n.get('text') or n.get('desc')][:40],
                        elements=[] if secure or not security_known else [dict(text=str(n.get('text') or n.get('desc') or '')[:160], id=str(n.get('id') or '')[:256], x=n['x'], y=n['y'], w=n['w'], h=n['h'], clickable=bool(n.get('clickable'))) for n in safe][:60],
                        focusedEditor=focused_editor, secure=secure, treeAvailable=tree_available, securityKnown=security_known, observationWarning='; '.join(warnings) or None, imageBase64=base64.b64encode(raw).decode())
        finally:
            os.unlink(shot)

    mode = req['mode']
    if mode == 'observe': return dict(observation=observe())
    op = req['operationId']
    if not re.fullmatch(r'[A-Za-z0-9-]{1,128}', op): raise ValueError('Invalid operation identity')
    receipt = root / (op + '.json')
    if mode == 'reconcile':
        record = json.loads(receipt.read_text()) if receipt.exists() else None
        if record and record['deviceId'] != serial: raise RuntimeError('Receipt device mismatch')
        return dict(receipt=record, observation=observe())
    if mode != 'action': raise ValueError('Unknown phone operation')
    if receipt.exists():
        _dispatched = True
        record = json.loads(receipt.read_text())
        if record.get('requestDigest') != req['requestDigest'] or record.get('deviceId') != serial: raise RuntimeError('Receipt identity mismatch')
        return dict(receipt=record, observation=observe())  # never repeat a dispatched action
    action = req['action']; kind = action['kind']
    before = observe()
    if not before['treeAvailable'] or not before['securityKnown']: raise RuntimeError('Screen safety unavailable; screenshot-only observation, hand input back to the user')
    if before['secure']: raise RuntimeError('Secure entry is visible. Hand the phone back to the user')
    # Coordinate/text input and Back depend on the approved visual state.
    # Home/Recents and a fixed package launch target explicit OS commands instead
    # of screen content; device, snapshot age and security checks still apply.
    if kind == 'type_text' and req.get('typingDigest'):
        if before.get('typingDigest') != req['typingDigest']: raise RuntimeError('stale_snapshot: typing target or surrounding screen changed; observe again')
    elif kind not in ('home', 'recents', 'open_app') and before['stateDigest'] != req['stateDigest']:
        raise RuntimeError('stale_snapshot: phone changed; observe again')
    if kind == 'type_text' and (re.fullmatch(r'\s*\d{4,8}\s*', action['text']) or re.search(r'password|passcode|verification code|one.time code|security code|enter.*pin', ' '.join(before['texts']), re.I)):
        raise RuntimeError('Authentication entry requires the user; passwords, PINs and verification codes are not supported')
    for x, y in ((action.get('x'), action.get('y')), (action.get('toX'), action.get('toY'))):
        if x is not None and not (0 <= x < before['width'] and 0 <= y < before['height']): raise ValueError('Coordinates outside the phone screen')
    snapshot = req['snapshotId']
    if not re.fullmatch(r'[a-f0-9-]{36}', snapshot): raise ValueError('Invalid snapshot identity')
    consumed = root / ('snapshot-' + snapshot + '.json')
    if consumed.exists(): raise RuntimeError('stale_snapshot: snapshot was already consumed; observe again')
    write_json(consumed, dict(operationId=op))
    record = dict(deviceId=serial, requestDigest=req['requestDigest'], status='dispatching', startedAt=int(time.time()*1000))
    write_json(receipt, record)  # durable intent BEFORE any input; a crash remains unknown
    _dispatched = True
    try:
        if kind == 'open_app': phone.send('apps.launch', name=action['package'])
        elif kind == 'tap': phone.send('input.tap', x=action['x'], y=action['y'])
        elif kind == 'swipe': phone.send('input.drag', x1=action['x'], y1=action['y'], x2=action['toX'], y2=action['toY'], duration=action['durationMs']/1000)
        elif kind == 'type_text': phone.send('input.text', s=action['text'])
        elif kind in ('home', 'back', 'recents'): phone.send('nav.' + kind)
        else: raise ValueError('Unsupported action')
        after = observe()
        record.update(status='completed', finishedAt=int(time.time()*1000))
        write_json(receipt, record)
        return dict(receipt=record, observation=after)
    except Exception as e:
        return dict(receipt=record, error='outcome_unknown: ' + str(e))

try:
    print(json.dumps(main()))
except Exception as e:
    print(json.dumps(dict(error=str(e), notDispatched=not _dispatched)))
`;
