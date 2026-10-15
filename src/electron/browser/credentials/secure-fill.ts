import { AUTOFILL_WORLD_ID, registerFilledPassword, registerFilledFragment } from "./autofill";
import type { FillTarget } from "./autofill";
import type { BrowserVaultFields, BrowserVaultKind } from "../../../shared/browser-vault";

/** Isolated-world code. Neither inspection nor the result returns field values. */
export function buildSecureFill(
  fields: BrowserVaultFields,
  kind: BrowserVaultKind | "code",
  origin: string,
  documentToken: string,
  inspectOnly = false,
): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)} || globalThis.__coworkVaultDocument !== ${JSON.stringify(documentToken)}) return { success:false, error:'page_changed' };
    const values = ${JSON.stringify(fields)};
    const kind = ${JSON.stringify(kind)};
    const inspectOnly = ${inspectOnly};
    const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled && !el.readOnly && el.type !== 'hidden'; };
    const safeForm = el => { try { return !el.form || new URL(el.form.action || location.href, location.href).origin === location.origin; } catch { return false; } };
    let inputs = [...document.querySelectorAll('input, select, textarea')].filter(el => visible(el) && safeForm(el));
    const auto = el => (el.autocomplete || '').toLowerCase().split(/\\s+/).pop();
    const hint = el => [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, ...[...(el.labels || [])].map(l => l.textContent)].join(' ').toLowerCase();
    const anchor = kind === 'payment' ? inputs.find(el => auto(el)?.startsWith('cc-')) : kind === 'address' ? inputs.find(el => auto(el) === 'address-line1' || /address.?1|address.line.?1|street/.test(hint(el))) : kind === 'login' ? inputs.find(el => el.type === 'password' && auto(el) !== 'new-password') : null;
    if (anchor?.form) inputs = inputs.filter(el => el.form === anchor.form);
    const set = (el, value) => {
      if (!value) return false;
      if (el.tagName === 'SELECT') {
        const norm = v => String(v).trim().toLowerCase().replace(/^0/, '');
        const opt = [...el.options].find(o => norm(o.value) === norm(value) || norm(o.textContent) === norm(value));
        if (!opt) return false;
        el.value = opt.value;
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (!setter) return false;
        setter.call(el, value);
      }
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      return el.value === value || el.tagName === 'SELECT';
    };
    let filledFields = 0, filledPassword = false;
    if (kind === 'login') {
      const pass = inputs.find(el => el.type === 'password' && auto(el) !== 'new-password' && !/new.?password|confirm|repeat/.test(hint(el)));
      const user = inputs.find(el => auto(el) === 'username') || inputs.find(el => auto(el) === 'email' || el.type === 'email') || inputs.find(el => ['text','tel'].includes(el.type) && /user|email|login|phone/.test(hint(el)) && (!pass || el.form === pass.form));
      if (user && set(user, values.username)) filledFields++;
      if (pass && set(pass, values.password)) { filledFields++; filledPassword = true; }
    } else if (kind === 'code') {
      const codes = inputs.filter(el => auto(el) === 'one-time-code' || /otp|verification.?code|security.?code|authenticator|totp|(?:^|[\\s_-])code(?:$|[\\s_-])/.test(hint(el)));
      if (inspectOnly) return {fillable:codes.length > 0};
      if (codes.length > 1 && codes.every(el => el.maxLength === 1)) {
        if (codes.length === values.code.length) codes.forEach((el,i) => { if(set(el, values.code[i])) filledFields++; });
      } else if (codes[0] && set(codes[0], values.code)) filledFields++;
    } else {
      const map = kind === 'payment' ? {cardholder:'cc-name', cardNumber:'cc-number', expMonth:'cc-exp-month', expYear:'cc-exp-year', cvc:'cc-csc', postalCode:'postal-code'} : {name:'name', addressLine1:'address-line1', addressLine2:'address-line2', city:'address-level2', state:'address-level1', postalCode:'postal-code', country:'country'};
      const hints = kind === 'payment' ? {cardholder:/card.?holder|name.on.card/,cardNumber:/card.?number|cc.?num/,expMonth:/exp.*month/,expYear:/exp.*year/,cvc:/cvc|cvv|security.?code/,postalCode:/zip|postal/} : {name:/full.?name/,addressLine1:/address.?1|address.line.?1|street/,addressLine2:/address.?2|address.line.?2/,city:/city|town/,state:/state|province|region/,postalCode:/zip|postal/,country:/country/};
      const used = new Set();
      for (const [field, token] of Object.entries(map)) {
        const el = inputs.find(el => !used.has(el) && (auto(el) === token || (field === 'country' && auto(el) === 'country-name'))) || inputs.find(el => !used.has(el) && hints[field].test(hint(el)));
        if (el && set(el, values[field])) { filledFields++; used.add(el); }
      }
      const expiry = inputs.find(el => auto(el) === 'cc-exp');
      if(kind === 'payment' && expiry && values.expMonth && values.expYear && set(expiry, expiry.type === 'month' ? values.expYear.padStart(4,'20')+'-'+values.expMonth.padStart(2,'0') : values.expMonth.padStart(2,'0')+'/'+values.expYear.slice(-2))) filledFields++;
    }
    return {success: filledFields > 0, filledFields, filledPassword, authenticationVerified:false};
  })()`;
}

export async function secureFill(
  target: FillTarget,
  fields: BrowserVaultFields,
  kind: BrowserVaultKind | "code",
  origin: string,
  documentToken: string,
  taskId: string,
  sessionId: string,
) {
  for (const value of Object.values(fields))
    if (value) registerFilledPassword(taskId, sessionId, value);
  // Retain both typed and normalized representations when sites format these fields.
  for (const key of ["cardNumber", "cvc", "code"]) {
    const normalized = fields[key]?.replace(/[\s-]/g, "");
    if (normalized) registerFilledPassword(taskId, sessionId, normalized);
  }
  if (kind === "code" && fields.code)
    for (const character of fields.code) registerFilledFragment(taskId, sessionId, character);
  return target.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [
    { code: buildSecureFill(fields, kind, origin, documentToken) },
  ]);
}
