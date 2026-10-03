/**
 * JavaScript sources that run inside the visible Browser Workbench page.
 *
 * Everything here is plain JavaScript text, never a TypeScript function that is
 * stringified: transpilers and coverage instrumentation rewrite function bodies,
 * and the daemon/cli tsconfigs have no DOM lib. The sources only reference
 * `document`, `window` and JavaScript built-ins so they can also be exercised
 * against a small fake DOM in unit tests.
 */

/**
 * Shared helper text prepended to the action functions below. `toElement`
 * maps text nodes (snapshot refs can point at them) to their parent element.
 */
const ACTION_HELPERS = String.raw`
  function toElement(node) { return node && node.nodeType === 1 ? node : node ? node.parentElement : null; }
  function describe(node) {
    var el = toElement(node);
    if (!el) return "unknown element";
    var out = String(el.tagName || "").toLowerCase();
    if (el.id) out += "#" + el.id;
    var cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) out += "." + cls.join(".");
    var tag = String(el.tagName || "").toUpperCase();
    // Never echo field values (passwords, personal data); name fields by their labels instead.
    var source = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
      ? el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || ""
      : el.innerText || el.textContent || "";
    var text = String(source).replace(/\s+/g, " ").trim().slice(0, 60);
    return text ? out + " \"" + text + "\"" : out;
  }
  function fieldKind(el) {
    if (!el) return "none";
    var tag = String(el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA") return "text";
    if (tag === "SELECT") return "select";
    if (tag === "INPUT") {
      var type = String(el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio" || type === "file" || type === "button" || type === "submit" || type === "reset" || type === "image" || type === "hidden") return "input-" + type;
      if (type === "date" || type === "time" || type === "datetime-local" || type === "month" || type === "week" || type === "range" || type === "color") return "set";
      return "text";
    }
    var editable = el.getAttribute ? el.getAttribute("contenteditable") : null;
    if (el.isContentEditable === true || (editable !== null && editable !== "false")) return "editable";
    return "none";
  }
  function isSecret(el) {
    return !!el && String(el.tagName || "").toUpperCase() === "INPUT" && String(el.getAttribute("type") || "").toLowerCase() === "password";
  }
  function nativeSetValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    while (proto) {
      var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && typeof descriptor.set === "function") { descriptor.set.call(el, value); return true; }
      proto = Object.getPrototypeOf(proto);
    }
    el.value = value;
    return false;
  }
  function readValue(el) {
    var kind = fieldKind(el);
    if (kind === "editable") return String(el.innerText != null ? el.innerText : el.textContent || "");
    return String(el.value == null ? "" : el.value);
  }
`;

/**
 * Runtime.callFunctionOn body (this = target node). Focuses and selects the
 * field's current contents so a following Input.insertText replaces them, the
 * same way a user selects-all and types. Types that cannot be typed into
 * (date, range, color, ...) are set through the native value setter so
 * framework-controlled inputs observe the change.
 */
export const PREPARE_FILL_FUNCTION = String.raw`function (value) {
  ${ACTION_HELPERS}
  var el = toElement(this);
  var kind = fieldKind(el);
  if (kind === "none" || kind === "select" || kind.indexOf("input-") === 0) {
    return { ok: false, kind: kind, target: describe(el) };
  }
  if (el.disabled === true || (el.readOnly === true && kind !== "editable")) {
    return { ok: false, kind: kind, target: describe(el), reason: el.disabled === true ? "disabled" : "readonly" };
  }
  if (typeof el.focus === "function") el.focus();
  var doc = el.ownerDocument || document;
  if (kind === "set") {
    nativeSetValue(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, kind: kind, focused: doc.activeElement === el };
  }
  if (kind === "editable") {
    var selection = window.getSelection ? window.getSelection() : null;
    if (selection && doc.createRange) {
      var range = doc.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  } else if (typeof el.select === "function") {
    el.select();
  }
  var active = doc.activeElement;
  var focused = active === el || (kind === "editable" && !!active && typeof el.contains === "function" && el.contains(active));
  return { ok: true, kind: kind, focused: focused };
}`;

/**
 * Runtime.callFunctionOn body (this = target node): clear or set a text field
 * through the native value setter and fire input/change events. Assigning
 * `el.value = x` updates React's value tracker first, so React concludes
 * nothing changed and drops the event; the prototype setter bypasses that.
 */
export const SET_FIELD_VALUE_FUNCTION = String.raw`function (value) {
  ${ACTION_HELPERS}
  var el = toElement(this);
  var kind = fieldKind(el);
  if (kind === "editable") {
    el.textContent = String(value);
  } else {
    nativeSetValue(el, String(value));
  }
  var inputEvent = typeof InputEvent === "function"
    ? new InputEvent("input", { bubbles: true, inputType: value ? "insertText" : "deleteContentBackward", data: value || null })
    : new Event("input", { bubbles: true });
  el.dispatchEvent(inputEvent);
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

/** Runtime.callFunctionOn body (this = target node): read back the field value. */
export const READ_FIELD_FUNCTION = String.raw`function () {
  ${ACTION_HELPERS}
  var el = toElement(this);
  return { kind: fieldKind(el), value: readValue(el), secret: isSecret(el), connected: !!el && el.isConnected !== false };
}`;

/**
 * Runtime.callFunctionOn body (this = target node, argument = node found by
 * hit-testing the click point). The click is on target when the hit node is
 * the target, a descendant (crossing shadow roots and same-origin frames), or a
 * label control relationship links them.
 */
export const HIT_TARGET_CHECK_FUNCTION = String.raw`function (hit) {
  ${ACTION_HELPERS}
  var target = toElement(this);
  var hitEl = toElement(hit);
  if (!target || !hitEl) return { ok: false, hit: describe(hitEl), target: describe(target) };
  var node = hitEl;
  for (var guard = 0; node && guard < 500; guard += 1) {
    if (node === target) return { ok: true };
    if (node.nodeType === 9) {
      var view = node.defaultView;
      node = view && view.frameElement ? view.frameElement : null;
      continue;
    }
    node = node.parentNode || node.host || null;
  }
  var label = hitEl.closest ? hitEl.closest("label") : null;
  if (label && label.control === target) return { ok: true, via: "label" };
  if (String(target.tagName || "").toUpperCase() === "LABEL" && target.control && target.control === hitEl) {
    return { ok: true, via: "label" };
  }
  return { ok: false, hit: describe(hitEl), target: describe(target) };
}`;

/**
 * Runtime.callFunctionOn body (this = target node, argument = event types):
 * record whether the target or a descendant receives those events, e.g.
 * mousedown/click for a click or beforeinput/input for text insertion.
 */
export const INSTALL_EVENT_PROBE_FUNCTION = String.raw`function (types) {
  ${ACTION_HELPERS}
  var el = toElement(this);
  if (!el || typeof el.addEventListener !== "function") return false;
  var key = Symbol.for("cowork.actionProbe");
  var previous = el[key];
  if (previous && previous.listener) {
    previous.types.forEach(function (type) { el.removeEventListener(type, previous.listener, true); });
  }
  var probe = { types: types, seen: {}, listener: null };
  probe.listener = function (event) { probe.seen[event.type] = true; };
  types.forEach(function (type) { el.addEventListener(type, probe.listener, true); });
  el[key] = probe;
  return true;
}`;

/** Runtime.callFunctionOn body (this = target node): read and remove the event probe. */
export const READ_EVENT_PROBE_FUNCTION = String.raw`function () {
  ${ACTION_HELPERS}
  var el = toElement(this);
  if (!el) return { installed: false, seen: {}, connected: false };
  var key = Symbol.for("cowork.actionProbe");
  var probe = el[key];
  if (probe && probe.listener) {
    probe.types.forEach(function (type) { el.removeEventListener(type, probe.listener, true); });
  }
  try { delete el[key]; } catch (error) { el[key] = undefined; }
  return { installed: !!probe, seen: probe ? probe.seen : {}, connected: el.isConnected !== false };
}`;

/** Runtime.callFunctionOn body (this = target node): focus it and report whether focus landed. */
export const FOCUS_FUNCTION = String.raw`function () {
  ${ACTION_HELPERS}
  var el = toElement(this);
  if (!el || typeof el.focus !== "function") return { ok: false, kind: fieldKind(el), target: describe(el) };
  el.focus();
  var doc = el.ownerDocument || document;
  var active = doc.activeElement;
  var kind = fieldKind(el);
  if (kind === "text" && typeof el.setSelectionRange === "function") {
    try { var end = String(el.value || "").length; el.setSelectionRange(end, end); } catch (error) { /* not all types support selection */ }
  }
  return { ok: active === el || (!!active && typeof el.contains === "function" && el.contains(active)), kind: kind, target: describe(el) };
}`;

/** Runtime.callFunctionOn body (this = target node): short description for error messages. */
export const DESCRIBE_NODE_FUNCTION = String.raw`function () {
  ${ACTION_HELPERS}
  return describe(this);
}`;
