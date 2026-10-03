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
 * `function(selector)` that resolves a selector to the single best element, or
 * returns a string starting with `invalid:` (bad selector) or `missing:` (no
 * match).
 *
 * Supported forms:
 * - CSS, optionally with `:has-text("x")`, `:text("x")`, `:text-is("x")` and
 *   `:visible` pseudo-classes in any compound (Playwright style)
 * - `text=Login` (case-insensitive substring), `text="Login"` (exact),
 *   `text=/log ?in/i` (regex)
 * - `role=button[name="Sign in"]` with optional `exact`, `level`, `checked`,
 *   `disabled`, `selected`, `expanded`, `pressed`
 * - `xpath=//button`, or a bare `//...` expression
 * - `css=...`, and chaining parts with ` >> `
 *
 * Text matches pick the deepest element whose own text matches (never
 * html/body), promote it to an enclosing interactive element, and prefer
 * visible, exact and interactive matches.
 */
export const SELECTOR_RESOLVER_SOURCE = String.raw`function (selector) {
  var MAX_SCAN = 6000;
  var SKIP_TAGS = { HTML: 1, HEAD: 1, BODY: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, META: 1, LINK: 1, TITLE: 1 };
  var INTERACTIVE_TAGS = { A: 1, BUTTON: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, SUMMARY: 1, LABEL: 1 };
  var INTERACTIVE_ROLES = { button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, option: 1, "switch": 1, textbox: 1, combobox: 1, searchbox: 1, treeitem: 1, slider: 1, spinbutton: 1 };
  function SelectorError(message) { this.message = message; }
  function norm(value) { return String(value == null ? "" : value).replace(/\s+/g, " ").trim(); }
  function tagOf(el) { return String((el && el.tagName) || "").toUpperCase(); }
  function attr(el, name) { return el && el.getAttribute ? el.getAttribute(name) : null; }
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    return !style || (style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none");
  }
  function isInteractive(el) {
    var tag = tagOf(el);
    if (INTERACTIVE_TAGS[tag]) return true;
    var role = String(attr(el, "role") || "").toLowerCase();
    if (INTERACTIVE_ROLES[role]) return true;
    if (attr(el, "onclick") !== null) return true;
    var tabindex = attr(el, "tabindex");
    if (tabindex !== null && tabindex !== "-1") return true;
    var editable = attr(el, "contenteditable");
    return el.isContentEditable === true || (editable !== null && editable !== "false");
  }
  function inputType(el) { return String(attr(el, "type") || "text").toLowerCase(); }
  function elementText(el) {
    var tag = tagOf(el);
    if (tag === "INPUT") {
      var type = inputType(el);
      return type === "button" || type === "submit" || type === "reset" ? norm(el.value) : "";
    }
    var text = typeof el.innerText === "string" ? el.innerText : el.textContent;
    return norm(text);
  }
  function rawText(el) {
    return tagOf(el) === "INPUT" ? elementText(el) : String(el.textContent || "");
  }
  function unquote(raw) {
    var quoted = /^(["'])([\s\S]*)\1$/.exec(raw);
    return quoted ? { text: quoted[2].replace(/\\(.)/g, "$1"), quoted: true } : { text: raw, quoted: false };
  }
  // mode: "auto" (quoted = exact, /re/ = regex, else substring), "exact", or
  // "substring" (Playwright :has-text("x") is a case-insensitive substring even when quoted).
  function makeTextMatcher(raw, mode) {
    raw = String(raw).trim();
    var regex = /^\/([\s\S]*)\/([dgimsuy]*)$/.exec(raw);
    if (regex) {
      var re;
      try { re = new RegExp(regex[1], regex[2].replace("g", "")); } catch (error) { throw new SelectorError("bad text regex " + raw + ": " + error.message); }
      return { quick: function () { return true; }, test: function (s) { return re.test(norm(s)); }, isExact: function () { return true; } };
    }
    var parsed = unquote(raw);
    var needle = norm(parsed.text);
    if (!needle) throw new SelectorError("empty text in selector");
    var lower = needle.toLowerCase();
    if (mode === "exact" || (mode !== "substring" && parsed.quoted)) {
      return {
        quick: function (s) { return String(s).indexOf(needle.split(" ")[0]) !== -1; },
        test: function (s) { return norm(s) === needle; },
        isExact: function () { return true; },
      };
    }
    return {
      quick: function (s) { return String(s).toLowerCase().indexOf(lower.split(" ")[0]) !== -1; },
      test: function (s) { return norm(s).toLowerCase().indexOf(lower) !== -1; },
      isExact: function (s) { return norm(s).toLowerCase() === lower; },
    };
  }
  function scanAll(root) {
    var list = root.querySelectorAll("*");
    var out = [];
    for (var i = 0; i < list.length && i < MAX_SCAN; i += 1) out.push(list[i]);
    return out;
  }
  function qsa(root, css) {
    try {
      var list = root.querySelectorAll(css);
      var out = [];
      for (var i = 0; i < list.length; i += 1) out.push(list[i]);
      return out;
    } catch (error) {
      throw new SelectorError("invalid CSS " + JSON.stringify(css) + ": " + ((error && error.message) || error));
    }
  }
  function matchesCss(el, css) {
    try { return el.matches(css); } catch (error) {
      throw new SelectorError("invalid CSS " + JSON.stringify(css) + ": " + ((error && error.message) || error));
    }
  }
  function uniq(list) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && !seen.has(list[i])) { seen.add(list[i]); out.push(list[i]); }
    }
    return out;
  }
  function deepestOnly(list) {
    var set = new Set(list);
    var hasMatchingDescendant = new Set();
    for (var i = 0; i < list.length; i += 1) {
      var parent = list[i].parentElement;
      while (parent) {
        if (set.has(parent)) hasMatchingDescendant.add(parent);
        parent = parent.parentElement;
      }
    }
    return list.filter(function (el) { return !hasMatchingDescendant.has(el) && !SKIP_TAGS[tagOf(el)]; });
  }
  function promoteToInteractive(el) {
    var current = el;
    for (var depth = 0; current && depth < 5; depth += 1) {
      if (SKIP_TAGS[tagOf(current)]) break;
      if (isInteractive(current)) return current;
      current = current.parentElement;
    }
    return el;
  }
  function textEngine(root, raw) {
    var matcher = makeTextMatcher(raw, "auto");
    var matches = [];
    var all = scanAll(root);
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (SKIP_TAGS[tagOf(el)]) continue;
      if (!matcher.quick(rawText(el))) continue;
      if (matcher.test(elementText(el))) matches.push(el);
    }
    var deepest = deepestOnly(matches);
    var exact = new Set();
    for (var j = 0; j < deepest.length; j += 1) {
      if (matcher.isExact(elementText(deepest[j]))) exact.add(deepest[j]);
    }
    var promoted = uniq(deepest.map(function (el) {
      var target = promoteToInteractive(el);
      if (exact.has(el)) exact.add(target);
      return target;
    }));
    return rank(promoted, exact);
  }
  function rank(list, exactSet) {
    var indexed = list.map(function (el, index) {
      var score = 0;
      if (!isVisible(el)) score += 100;
      if (exactSet && !exactSet.has(el)) score += 10;
      if (!isInteractive(el)) score += 1;
      return { el: el, score: score, index: index };
    });
    indexed.sort(function (a, b) { return a.score - b.score || a.index - b.index; });
    return indexed.map(function (item) { return item.el; });
  }
  function implicitRole(el) {
    var explicit = String(attr(el, "role") || "").trim().split(/\s+/)[0].toLowerCase();
    if (explicit) return explicit;
    var tag = tagOf(el);
    if (tag === "A" || tag === "AREA") return attr(el, "href") !== null ? "link" : "";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return el.multiple || Number(attr(el, "size")) > 1 ? "listbox" : "combobox";
    if (tag === "OPTION") return "option";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return attr(el, "alt") === "" ? "presentation" : "img";
    if (tag === "INPUT") {
      var type = inputType(el);
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return attr(el, "list") !== null ? "combobox" : "searchbox";
      if (type === "hidden" || type === "file" || type === "color" || type === "date" || type === "time") return "";
      return attr(el, "list") !== null ? "combobox" : "textbox";
    }
    var map = { NAV: "navigation", MAIN: "main", UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader", FORM: "form", DIALOG: "dialog", ARTICLE: "article", ASIDE: "complementary", HEADER: "banner", FOOTER: "contentinfo", P: "paragraph", HR: "separator", PROGRESS: "progressbar" };
    if (map[tag]) return map[tag];
    var editable = attr(el, "contenteditable");
    if (editable !== null && editable !== "false") return "textbox";
    return "";
  }
  function textById(id) {
    var node = document.getElementById ? document.getElementById(id) : null;
    return node ? norm(node.textContent) : "";
  }
  function accessibleName(el) {
    var labelledBy = attr(el, "aria-labelledby");
    if (labelledBy) {
      var joined = labelledBy.split(/\s+/).map(textById).filter(Boolean).join(" ");
      if (joined) return joined;
    }
    var ariaLabel = norm(attr(el, "aria-label"));
    if (ariaLabel) return ariaLabel;
    var tag = tagOf(el);
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      var type = inputType(el);
      if (tag === "INPUT" && (type === "button" || type === "submit" || type === "reset")) {
        return norm(el.value) || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
      }
      var id = attr(el, "id");
      if (id && document.querySelectorAll) {
        var labels = qsa(document, "label");
        for (var i = 0; i < labels.length; i += 1) {
          if (attr(labels[i], "for") === id) return norm(labels[i].textContent);
        }
      }
      var wrapping = el.closest ? el.closest("label") : null;
      if (wrapping) return norm(wrapping.textContent);
      return norm(attr(el, "placeholder")) || norm(attr(el, "title"));
    }
    if (tag === "IMG") return norm(attr(el, "alt")) || norm(attr(el, "title"));
    return elementText(el) || norm(attr(el, "title"));
  }
  function parseRoleSelector(body) {
    var head = /^\s*([a-zA-Z-]+)\s*/.exec(body);
    if (!head) throw new SelectorError("role selector needs a role, e.g. role=button[name=\"Save\"]");
    var role = head[1].toLowerCase();
    var rest = body.slice(head[0].length);
    var attrs = {};
    var attrRe = /^\[\s*([a-zA-Z-]+)\s*(?:=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^\/\\]|\\.)+\/[a-z]*|[^\]\s]+))?\s*([is])?\s*\]\s*/;
    while (rest.length) {
      var match = attrRe.exec(rest);
      if (!match) throw new SelectorError("cannot parse role selector attributes " + JSON.stringify(rest));
      attrs[match[1].toLowerCase()] = { value: match[2] === undefined ? "true" : match[2], flag: match[3] || "" };
      rest = rest.slice(match[0].length);
    }
    return { role: role, attrs: attrs };
  }
  function roleEngine(root, body) {
    var parsed = parseRoleSelector(body);
    var known = { name: 1, exact: 1, level: 1, checked: 1, disabled: 1, selected: 1, expanded: 1, pressed: 1, "include-hidden": 1 };
    for (var key in parsed.attrs) {
      if (!known[key]) throw new SelectorError("unsupported role selector attribute [" + key + "]");
    }
    var exactFlag = parsed.attrs.exact && parsed.attrs.exact.value !== "false";
    var nameMode = exactFlag || parsed.attrs.name && parsed.attrs.name.flag === "s" ? "exact" : "substring";
    var nameMatcher = parsed.attrs.name ? makeTextMatcher(parsed.attrs.name.value, nameMode) : null;
    function stateMatches(el, key) {
      var spec = parsed.attrs[key];
      if (!spec) return true;
      var want = unquote(spec.value).text;
      var actual;
      if (key === "level") actual = String(attr(el, "aria-level") || (/^H([1-6])$/.exec(tagOf(el)) || [])[1] || "");
      else if (key === "checked") actual = String(attr(el, "aria-checked") || (el.checked === true ? "true" : "false"));
      else if (key === "disabled") actual = String(attr(el, "aria-disabled") === "true" || el.disabled === true);
      else if (key === "selected") actual = String(attr(el, "aria-selected") === "true" || el.selected === true);
      else if (key === "expanded") actual = String(attr(el, "aria-expanded") || "false");
      else actual = String(attr(el, "aria-pressed") || "false");
      return actual === want;
    }
    var all = scanAll(root);
    var matches = [];
    var exact = new Set();
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (implicitRole(el) !== parsed.role) continue;
      if (!stateMatches(el, "level") || !stateMatches(el, "checked") || !stateMatches(el, "disabled") ||
          !stateMatches(el, "selected") || !stateMatches(el, "expanded") || !stateMatches(el, "pressed")) continue;
      if (nameMatcher) {
        var name = accessibleName(el);
        if (!nameMatcher.test(name)) continue;
        if (nameMatcher.isExact(name)) exact.add(el);
      }
      matches.push(el);
    }
    return rank(matches, nameMatcher ? exact : null);
  }
  function xpathEngine(root, expression) {
    if (!document.evaluate) throw new SelectorError("XPath is not supported in this page");
    var result;
    try { result = document.evaluate(expression, root, null, 7, null); } catch (error) {
      throw new SelectorError("invalid XPath " + JSON.stringify(expression) + ": " + ((error && error.message) || error));
    }
    var out = [];
    for (var i = 0; i < result.snapshotLength; i += 1) {
      var node = result.snapshotItem(i);
      if (node && node.nodeType === 1) out.push(node);
    }
    return rank(out, null);
  }
  function splitTopLevel(source, separators) {
    var parts = [];
    var depthParen = 0;
    var depthBracket = 0;
    var quote = "";
    var current = "";
    for (var i = 0; i < source.length; i += 1) {
      var ch = source[i];
      if (quote) {
        current += ch;
        if (ch === "\\" && i + 1 < source.length) { current += source[i + 1]; i += 1; continue; }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "\"" || ch === "'") { quote = ch; current += ch; continue; }
      if (ch === "(") depthParen += 1;
      if (ch === ")") depthParen -= 1;
      if (ch === "[") depthBracket += 1;
      if (ch === "]") depthBracket -= 1;
      if (depthParen === 0 && depthBracket === 0 && separators.indexOf(ch) !== -1) {
        parts.push({ text: current, separator: ch });
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push({ text: current, separator: "" });
    return parts;
  }
  var CUSTOM_PSEUDO = /:(has-text|text-is|text|visible)(?:\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^)]*?)\s*\))?/g;
  function parseCompounds(complex) {
    var tokens = splitTopLevel(complex.trim(), " >+~");
    var compounds = [];
    var combinator = " ";
    for (var i = 0; i < tokens.length; i += 1) {
      var text = tokens[i].text.trim();
      if (text) {
        var filters = [];
        var css = text.replace(CUSTOM_PSEUDO, function (_all, name, arg) {
          filters.push({ name: name, arg: arg === undefined ? "" : arg });
          return "";
        });
        compounds.push({ combinator: combinator, css: css || "*", filters: filters });
        combinator = " ";
      }
      if (tokens[i].separator && tokens[i].separator !== " ") combinator = tokens[i].separator;
    }
    return compounds;
  }
  function applyFilters(list, filters) {
    var out = list;
    var textual = false;
    var exact = null;
    filters.forEach(function (filter) {
      if (filter.name === "visible") { out = out.filter(isVisible); return; }
      textual = true;
      var matcher = makeTextMatcher(filter.arg, filter.name === "text-is" ? "exact" : unquote(filter.arg).quoted ? "substring" : "auto");
      out = out.filter(function (el) { return !SKIP_TAGS[tagOf(el)] && matcher.test(elementText(el)); });
      exact = new Set(out.filter(function (el) { return matcher.isExact(elementText(el)); }));
    });
    return { list: out, textual: textual, exact: exact };
  }
  function cssEngine(root, complex) {
    var groups = splitTopLevel(complex, ",").map(function (part) { return part.text.trim(); }).filter(Boolean);
    var results = [];
    var usesCustom = false;
    groups.forEach(function (group) {
      CUSTOM_PSEUDO.lastIndex = 0;
      if (!CUSTOM_PSEUDO.test(group)) { results = results.concat(qsa(root, group)); return; }
      usesCustom = true;
      var compounds = parseCompounds(group);
      var current = null;
      var last = null;
      compounds.forEach(function (compound, index) {
        var next = [];
        if (index === 0) {
          next = qsa(root, compound.css);
        } else {
          current.forEach(function (el) {
            if (compound.combinator === ">") {
              Array.prototype.forEach.call(el.children || [], function (child) { if (matchesCss(child, compound.css)) next.push(child); });
            } else if (compound.combinator === "+") {
              if (el.nextElementSibling && matchesCss(el.nextElementSibling, compound.css)) next.push(el.nextElementSibling);
            } else if (compound.combinator === "~") {
              for (var sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) if (matchesCss(sib, compound.css)) next.push(sib);
            } else {
              next = next.concat(qsa(el, compound.css));
            }
          });
          next = uniq(next);
        }
        last = applyFilters(next, compound.filters);
        last.generic = compound.css === "*";
        current = last.list;
      });
      var list = current || [];
      if (last && last.textual && last.generic) {
        var deep = deepestOnly(list);
        var exactSet = new Set();
        list = uniq(deep.map(function (el) {
          var target = promoteToInteractive(el);
          if (last.exact && last.exact.has(el)) exactSet.add(target);
          return target;
        }));
        results = results.concat(rank(list, exactSet));
      } else {
        results = results.concat(last && last.textual ? rank(list, last.exact) : list);
      }
    });
    var unique = uniq(results);
    if (usesCustom) return unique;
    var visible = unique.filter(isVisible);
    return visible.concat(unique.filter(function (el) { return !isVisible(el); }));
  }
  function runEngine(root, part) {
    var trimmed = part.trim();
    var engine = /^(css|text|role|xpath)\s*=/.exec(trimmed);
    if (engine) {
      var body = trimmed.slice(engine[0].length);
      if (engine[1] === "text") return textEngine(root, body);
      if (engine[1] === "role") return roleEngine(root, body);
      if (engine[1] === "xpath") return xpathEngine(root, body);
      return cssEngine(root, body);
    }
    if (/^\(*\/\//.test(trimmed) || /^\.\.?\//.test(trimmed)) return xpathEngine(root, trimmed);
    if (/^(["']).*\1$/.test(trimmed)) return textEngine(root, trimmed);
    return cssEngine(root, trimmed);
  }
  try {
    var source = String(selector == null ? "" : selector).trim();
    if (!source) return "invalid:empty selector";
    var parts = source.split(/\s+>>\s+/);
    var roots = [document];
    var found = [];
    for (var p = 0; p < parts.length; p += 1) {
      found = [];
      for (var r = 0; r < roots.length; r += 1) found = found.concat(runEngine(roots[r], parts[p]));
      found = uniq(found).filter(function (el) { return tagOf(el) !== "HTML" && tagOf(el) !== "HEAD"; });
      if (found.length === 0) break;
      roots = found;
    }
    if (found.length === 0) return "missing:no element matches " + JSON.stringify(source);
    return found[0];
  } catch (error) {
    if (error instanceof SelectorError) return "invalid:" + error.message;
    return "invalid:" + ((error && error.message) || String(error));
  }
}`;

/** Expression that evaluates to the resolved element or an `invalid:`/`missing:` string. */
export function buildSelectorResolverExpression(selector: string): string {
  return `(${SELECTOR_RESOLVER_SOURCE})(${JSON.stringify(String(selector ?? ""))})`;
}

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

/** Expression describing the currently focused element. */
export const ACTIVE_ELEMENT_EXPRESSION = String.raw`(function () {
  ${ACTION_HELPERS}
  var active = document.activeElement;
  return active && active !== document.body ? describe(active) : "";
})()`;

/**
 * `function(selector, value)` for executeJavaScript: choose a <select> option
 * by value or visible label, set it through the native setter and verify it.
 */
export function buildSelectOptionExpression(selector: string, value: string): string {
  return String.raw`(function () {
  ${ACTION_HELPERS}
  var resolved = (${SELECTOR_RESOLVER_SOURCE})(${JSON.stringify(String(selector ?? ""))});
  if (typeof resolved === "string") return { success: false, error: resolved.replace(/^(invalid|missing):/, "") };
  var el = resolved;
  if (String(el.tagName || "").toUpperCase() !== "SELECT") {
    return { success: false, error: "Element is not a select dropdown: " + describe(el) };
  }
  var wanted = ${JSON.stringify(String(value ?? ""))};
  var options = Array.prototype.slice.call(el.options || el.querySelectorAll("option"));
  var norm = function (s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); };
  var option = options.find(function (o) { return o.value === wanted; }) ||
    options.find(function (o) { return norm(o.label || o.textContent) === norm(wanted); }) ||
    options.find(function (o) { return norm(o.label || o.textContent).toLowerCase() === norm(wanted).toLowerCase(); });
  if (!option) {
    return { success: false, error: "No option with value or label " + JSON.stringify(wanted), options: options.slice(0, 30).map(function (o) { return { value: o.value, label: norm(o.label || o.textContent) }; }) };
  }
  if (option.disabled) return { success: false, error: "Option " + JSON.stringify(wanted) + " is disabled" };
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", inline: "center" });
  nativeSetValue(el, option.value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (el.value !== option.value) return { success: false, error: "The page reset the selection (value is " + JSON.stringify(el.value) + ")" };
  return { success: true, value: el.value, label: norm(option.label || option.textContent), url: location.href };
})()`;
}
