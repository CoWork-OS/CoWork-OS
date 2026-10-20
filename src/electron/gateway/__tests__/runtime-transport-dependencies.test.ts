import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MattermostClient } from "../channels/mattermost-client";

const require = createRequire(import.meta.url);
type CommonJSWebSocket = typeof import("ws").default & {
  Server: typeof import("ws").WebSocketServer;
};
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  const failures: unknown[] = [];
  for (const dispose of cleanup.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Transport fixture cleanup failed");
});

async function temporaryDirectory() {
  const directory = await mkdtemp(
    join(process.env.COWORK_SECURITY_TEST_TMP ?? tmpdir(), "cowork-transport-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function body(request: IncomingMessage | Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: Error) => response.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}

describe("installed gateway transport dependencies", () => {
  it.each([
    ["ordinary notes.txt", 'filename="ordinary notes.txt"'],
    [
      'notes"\r\nX-Injected: yes\r\n\r\npayload.txt',
      'filename="notes%22%0D%0AX-Injected: yes%0D%0A%0D%0Apayload.txt"',
    ],
  ])(
    "streams a real Mattermost multipart upload safely for %j",
    async (filename, expectedDisposition) => {
      const directory = await temporaryDirectory();
      const file = join(directory, "source.txt");
      await writeFile(file, "synthetic streamed file\n");
      let captured:
        | { bytes: Buffer; authorization?: string; contentType?: string; url?: string }
        | undefined;
      const url = await serve(async (request, response) => {
        captured = {
          bytes: await body(request),
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          url: request.url,
        };
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ file_infos: [{ id: "fixture-file" }] }));
      });
      const client = new MattermostClient({ serverUrl: url, token: "fixture-token" });
      expect(await client.uploadFile("fixture-channel", file, filename)).toEqual({
        file_infos: [{ id: "fixture-file" }],
      });
      expect(captured?.url).toBe("/api/v4/files");
      expect(captured?.authorization).toBe("Bearer fixture-token");
      expect(captured?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      const multipart = captured!.bytes.toString("utf8");
      expect(multipart).toContain(expectedDisposition);
      expect(multipart).not.toContain("\r\nX-Injected:");
      expect(multipart).toContain('name="channel_id"\r\n\r\nfixture-channel\r\n');
      expect(multipart).toContain("synthetic streamed file\n");
    },
  );

  it("preserves Axios streaming downloads, streamed POST bodies, redirects and HTTP errors", async () => {
    // Resolve the SDK's own dependency rather than assuming a particular hoisting layout.
    const axios = createRequire(require.resolve("botbuilder"))(
      "axios",
    ) as typeof import("axios").default;
    const url = await serve(async (request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/download" });
        response.end();
      } else if (request.url === "/download") {
        response.write("stream-");
        response.end("fixture");
      } else if (request.url === "/upload") {
        const bytes = await body(request);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            method: request.method,
            text: bytes.toString(),
            marker: request.headers["x-fixture"],
          }),
        );
      } else {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "fixture unavailable" }));
      }
    });
    const download = await axios.get(`${url}/redirect`, {
      proxy: false,
      responseType: "stream",
      timeout: 2000,
    });
    expect((await body(download.data)).toString()).toBe("stream-fixture");
    const upload = await axios.post(`${url}/upload`, Readable.from(["chunk-one", "-two"]), {
      proxy: false,
      maxRedirects: 0,
      timeout: 2000,
      headers: { "content-type": "application/octet-stream", "x-fixture": "retained" },
    });
    expect(upload.status).toBe(201);
    expect(upload.data).toEqual({ method: "POST", text: "chunk-one-two", marker: "retained" });
    await expect(
      axios.get(`${url}/failure`, { proxy: false, timeout: 2000 }),
    ).rejects.toMatchObject({
      response: { status: 503, data: { error: "fixture unavailable" } },
    });
  });

  it("enforces Axios maxBodyLength for streamed uploads when redirects are disabled", async () => {
    const axios = createRequire(require.resolve("baileys"))(
      "axios",
    ) as typeof import("axios").default;
    const url = await serve(async (request, response) => {
      await body(request);
      response.end("accepted");
    });
    await expect(
      axios.post(url, Readable.from([Buffer.alloc(32, "x")]), {
        proxy: false,
        maxRedirects: 0,
        maxBodyLength: 8,
        timeout: 2000,
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/maxBodyLength/i) });
  });

  it("exchanges binary messages through the real Bot Framework NodeWebSocket wrapper", async () => {
    const sdkRequire = createRequire(require.resolve("botframework-streaming"));
    const WebSocket = sdkRequire("ws") as CommonJSWebSocket;
    const { NodeWebSocket } = sdkRequire(
      "botframework-streaming",
    ) as typeof import("botframework-streaming");
    const server = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanup.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    server.on("connection", (socket) => socket.on("message", (bytes) => socket.send(bytes)));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing WebSocket fixture port");
    const client = new NodeWebSocket();
    cleanup.push(() => client.close());
    await client.connect(`ws://127.0.0.1:${address.port}`);
    const received = new Promise<Buffer>((resolve) =>
      client.setOnMessageHandler((bytes) => resolve(Buffer.from(bytes))),
    );
    client.write(Buffer.from([0, 1, 127, 255]));
    expect(await received).toEqual(Buffer.from([0, 1, 127, 255]));
    expect(client.isConnected).toBe(true);
  });

  it("bounds tiny fragmented messages in Bot Framework's installed ws receiver", async () => {
    const WebSocket = createRequire(require.resolve("botframework-streaming"))(
      "ws",
    ) as CommonJSWebSocket;
    // maxFragments was backported with the memory-exhaustion fix; keep the fixture tiny.
    const server = new WebSocket.Server({
      host: "127.0.0.1",
      port: 0,
      maxFragments: 4,
    } as import("ws").ServerOptions);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanup.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    });
    const failure = new Promise<string>((resolve) =>
      server.on("connection", (socket) =>
        socket.once("error", (error: Error) => resolve(error.message)),
      ),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing WebSocket fixture port");
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    cleanup.push(() => client.terminate());
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.once("open", resolve));
    for (let i = 0; i < 6; i++) client.send(Buffer.from("x"), { fin: false });
    client.send(Buffer.from("x"), { fin: true });
    expect(await failure).toMatch(/fragments/i);
  });
});

function wavFixture() {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

describe("installed WhatsApp media dependencies", () => {
  it("resizes and encodes native raster and SVG inputs with sharp", async () => {
    const sharp = createRequire(require.resolve("baileys"))(
      "sharp",
    ) as typeof import("sharp").default;
    const raster = await sharp({ create: { width: 4, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    for (const input of [
      raster,
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2" fill="red"/></svg>',
      ),
    ]) {
      const resized = await sharp(input).resize(2, 1).png().toBuffer({ resolveWithObject: true });
      expect(resized.info).toMatchObject({ width: 2, height: 1, format: "png" });
      expect(await sharp(resized.data).removeAlpha().raw().toBuffer()).toEqual(
        Buffer.from([255, 0, 0, 255, 0, 0]),
      );
    }
    await expect(
      sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><broken>')).png().toBuffer(),
    ).rejects.toThrow();
  });

  it("reads WAV duration from a buffer, file and stream using music-metadata's public APIs", async () => {
    const mediaRequire = createRequire(require.resolve("baileys"));
    const metadata = (await import(
      pathToFileURL(mediaRequire.resolve("music-metadata")).href
    )) as typeof import("music-metadata");
    const directory = await temporaryDirectory();
    const filename = join(directory, "fixture.wav");
    await writeFile(filename, wavFixture());
    const bytes = await readFile(filename);
    const results = [
      await metadata.parseBuffer(bytes, undefined, { duration: true }),
      await metadata.parseFile(filename, { duration: true }),
      await metadata.parseStream(Readable.from([bytes]), undefined, { duration: true }),
    ];
    for (const result of results) {
      expect(result.format).toMatchObject({
        sampleRate: 8000,
        numberOfChannels: 1,
        bitsPerSample: 16,
      });
      expect(result.format.duration).toBeCloseTo(0.1, 6);
    }
  });
});

const uuidOwners = [
  "botbuilder",
  "botbuilder-core",
  "botframework-schema",
  "botframework-streaming",
  "@azure/msal-node",
  "@azure/identity",
];
describe("SDK CommonJS UUID compatibility", () => {
  it.each(uuidOwners)(
    "preserves CJS generation and rejects undersized output buffers for %s",
    (owner) => {
      let sdkRequire = createRequire(require.resolve(owner));
      if (owner === "@azure/identity")
        sdkRequire = createRequire(sdkRequire.resolve("@azure/msal-node"));
      const uuid = sdkRequire("uuid") as typeof import("uuid");
      expect(uuid.validate(uuid.v4())).toBe(true);
      for (const generate of [uuid.v3, uuid.v5]) {
        const expected = generate("fixture", generate.DNS);
        const output = Buffer.alloc(16);
        generate("fixture", generate.DNS, output);
        expect(uuid.stringify(output)).toBe(expected);
        expect(() => generate("fixture", generate.DNS, Buffer.alloc(1))).toThrow();
        expect(() => generate("fixture", generate.DNS, Buffer.alloc(16), 1)).toThrow();
      }
    },
  );
});
