import { createHmac } from "node:crypto";

/** RFC 6238, including the parameters carried by otpauth://totp links. */
export function parseAuthenticator(value: string) {
  let seed = value.trim();
  let digits = 6;
  let period = 30;
  let algorithm = "SHA1";
  if (/^otpauth:/i.test(seed)) {
    const uri = new URL(seed);
    if (uri.protocol !== "otpauth:" || uri.hostname !== "totp")
      throw new Error("Use a TOTP authenticator key.");
    seed = uri.searchParams.get("secret") || "";
    digits = Number(uri.searchParams.get("digits") || 6);
    period = Number(uri.searchParams.get("period") || 30);
    algorithm = (uri.searchParams.get("algorithm") || "SHA1").toUpperCase();
  }
  seed = seed.toUpperCase().replace(/[\s=-]/g, "");
  if (
    !/^[A-Z2-7]{16,1024}$/.test(seed) ||
    ![6, 7, 8].includes(digits) ||
    !Number.isInteger(period) ||
    period < 1 ||
    period > 300 ||
    !["SHA1", "SHA256", "SHA512"].includes(algorithm)
  ) {
    throw new Error("Invalid authenticator key or parameters.");
  }
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const ch of seed) {
    buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  return { key: Buffer.from(bytes), digits, period, algorithm: algorithm.toLowerCase() };
}

export function authenticatorCode(value: string, now = Date.now()): string {
  const { key, digits, period, algorithm } = parseAuthenticator(value);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)));
  const digest = createHmac(algorithm, key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}
