/**
 * Ephemeral TLS credentials for an https loopback OAuth redirect.
 *
 * Some providers (Workday) only register https redirect URIs, so the callback
 * listener on 127.0.0.1 must speak TLS. Each sign-in gets a fresh P-256 key and
 * a self-signed certificate valid for one day. Both live only in memory for the
 * lifetime of the listener: nothing is written to disk, logged or reused. The
 * browser shows a certificate warning once per sign-in, which the person
 * accepts for 127.0.0.1.
 *
 * Pure Node: a minimal DER encoder builds the X.509 v3 certificate.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";

const CERT_VALIDITY_MS = 24 * 60 * 60 * 1000;
/** Tolerates a small clock difference between this process and the browser. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items: Buffer[]) => der(0x30, ...items);
const set = (...items: Buffer[]) => der(0x31, ...items);
const octetString = (value: Buffer) => der(0x04, value);
const bitString = (value: Buffer) => der(0x03, Buffer.from([0]), value);
const explicit = (tagNumber: number, value: Buffer) => der(0xa0 | tagNumber, value);

function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

function commonName(name: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(name, "utf8")))));
}

function extension(id: string, value: Buffer, critical = false): Buffer {
  return sequence(
    oid(id),
    ...(critical ? [der(0x01, Buffer.from([0xff]))] : []),
    octetString(value),
  );
}

const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));
const LOOPBACK_IPV4 = Buffer.from([127, 0, 0, 1]);
const LOOPBACK_IPV6 = Buffer.from([...Array(15).fill(0), 1]);

export interface LoopbackTlsCredentials {
  /** PKCS#8 PEM; held in memory only for the listener's lifetime. */
  key: string;
  cert: string;
}

/** A fresh key pair and self-signed certificate for 127.0.0.1, [::1] and localhost. */
export function createLoopbackTlsCredentials(now = Date.now()): LoopbackTlsCredentials {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(16);
  // A positive integer without a leading zero byte keeps the DER minimal.
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const name = commonName("127.0.0.1");
  const subjectAltName = sequence(
    der(0x87, LOOPBACK_IPV4),
    der(0x87, LOOPBACK_IPV6),
    der(0x82, Buffer.from("localhost", "ascii")),
  );
  const tbs = sequence(
    explicit(0, der(0x02, Buffer.from([2]))), // X.509 v3
    der(0x02, serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(now - CLOCK_SKEW_MS)), utcTime(new Date(now + CERT_VALIDITY_MS))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(
      3,
      sequence(
        extension("2.5.29.19", sequence(), true), // basicConstraints: not a CA
        extension("2.5.29.15", der(0x03, Buffer.from([7, 0x80])), true), // keyUsage: digitalSignature
        extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
        extension("2.5.29.17", subjectAltName),
      ),
    ),
  );
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, bitString(sign("sha256", tbs, privateKey)));
  const base64 = certificate.toString("base64").replace(/.{1,64}/g, "$&\n");
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----\n`,
  };
}
