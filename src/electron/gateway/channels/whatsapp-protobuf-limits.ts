// Baileys' pre-generated decoders predate protobufjs' generated nesting guards.
// Updating the runtime protects unknown groups, but not recursive message fields.
export const WHATSAPP_PROTOBUF_MAX_DEPTH = 100;

const installed = new WeakSet<object>();

/** Bound all nested generated decode calls before a WhatsApp socket is created. */
export function installWhatsAppProtobufDepthLimit(namespace: object): void {
  if (installed.has(namespace)) return;

  const visited = new WeakSet<object>();
  const pending = [namespace];
  let depth = 0;
  let decoders = 0;

  while (pending.length) {
    const value = pending.pop()!;
    if (visited.has(value)) continue;
    visited.add(value);

    for (const child of Object.values(value)) {
      if (child !== null && (typeof child === "object" || typeof child === "function")) {
        pending.push(child);
      }
    }

    if (typeof value === "function" && "decode" in value && typeof value.decode === "function") {
      const decode = value.decode;
      value.decode = function (this: unknown, ...args: unknown[]) {
        if (depth >= WHATSAPP_PROTOBUF_MAX_DEPTH) {
          throw new Error("WhatsApp protobuf message nesting depth exceeded");
        }
        depth++;
        try {
          return decode.apply(this, args);
        } finally {
          depth--;
        }
      };
      decoders++;
    }
  }

  if (decoders === 0) throw new Error("WhatsApp protobuf decoders are unavailable");
  installed.add(namespace);
}
