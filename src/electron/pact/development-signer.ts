/**
 * Development deployment of the PACT signer contract: disposable keys in memory, a loopback issuer
 * whose JWKS is served at `{issuer}/.well-known/jwks.json`, http only on 127.0.0.1.
 *
 * For tests and local interoperability runs against the reference provider. It is only selectable
 * when COWORK_PACT_DEVELOPMENT=1 and is never used as a fallback for another deployment.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { generateEs256KeyPair, signCompactJws, type Es256KeyPair } from "./jws";
import type { PactSignedToken, PactSigner, PactSignerStatus } from "./signer-client";

export const PACT_DEVELOPMENT_ENV = "COWORK_PACT_DEVELOPMENT";
const DEFAULT_TTL_SECONDS = 120;

export function isPactDevelopmentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PACT_DEVELOPMENT_ENV] === "1";
}

export class DevelopmentPactSigner implements PactSigner {
  readonly deployment = "development" as const;
  private keys: Es256KeyPair[];
  private server: Server | null = null;
  private issuerUrl: string;

  constructor(
    private readonly options: {
      subject: string;
      /** Fixed issuer when the JWKS is hosted elsewhere (tests); otherwise `start()` sets it. */
      issuer?: string;
      audiences?: Record<string, string>;
      ttlSeconds?: number;
      now?: () => number;
    },
  ) {
    this.keys = [generateEs256KeyPair()];
    this.issuerUrl = options.issuer ?? "";
  }

  get issuer(): string {
    if (!this.issuerUrl) throw new Error("Development signer has not been started");
    return this.issuerUrl;
  }

  jwks(): { keys: Es256KeyPair["publicJwk"][] } {
    return { keys: this.keys.map((key) => key.publicJwk) };
  }

  /** Add a new key and keep the old ones published, as a rotation overlap. */
  rotate(): void {
    this.keys = [generateEs256KeyPair(), ...this.keys].slice(0, 3);
  }

  /** Serve the JWKS on a loopback port; the issuer becomes http://127.0.0.1:<port>. */
  async start(port = 0): Promise<string> {
    if (this.server) return this.issuer;
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/.well-known/jwks.json") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(this.jwks()));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback address");
    this.server = server;
    this.issuerUrl = `http://127.0.0.1:${address.port}`;
    return this.issuerUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async sign(audience: string): Promise<PactSignedToken> {
    if (!audience) throw new Error("Audience is required");
    const ttl = this.options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const iat = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const key = this.keys[0]!;
    const token = signCompactJws(
      JSON.stringify({
        iss: this.issuer,
        sub: this.options.subject,
        aud: audience,
        iat,
        exp: iat + ttl,
        jti: randomUUID(),
      }),
      { alg: "ES256", kid: key.publicJwk.kid, typ: "JWT" },
      key.privateKey,
    );
    return {
      token,
      issuer: this.issuer,
      subject: this.options.subject,
      audience,
      issuedAt: iat * 1000,
      expiresAt: (iat + ttl) * 1000,
    };
  }

  async status(): Promise<PactSignerStatus> {
    return {
      ok: Boolean(this.issuerUrl),
      issuer: this.issuerUrl,
      subject: this.options.subject,
      jwksUri: `${this.issuerUrl}/.well-known/jwks.json`,
      disabled: false,
      audiences: { ...this.options.audiences },
    };
  }
}
