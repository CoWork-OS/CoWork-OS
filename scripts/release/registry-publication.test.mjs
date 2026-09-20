import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, symlink, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRegistry, publishPackage, runCli } from "./registry-publication.mjs";

const bytes = Buffer.from("bundle");
const otherBytes = Buffer.from("different bundle");
const integrity = (value) => `sha512-${createHash("sha512").update(value).digest("base64")}`;
const entry = Object.freeze({
  id: "npm",
  name: "cowork-os",
  registry: "https://registry.npmjs.org",
  version: "1.2.3",
  filename: "pkg.tgz",
  size: bytes.length,
  integrity: integrity(bytes),
});
const response = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
const version = (
  forEntry = entry,
  tarball = "https://registry.npmjs.org/cowork-os/-/cowork-os.tgz",
  hash = forEntry.integrity,
) => ({ name: forEntry.name, version: forEntry.version, dist: { integrity: hash, tarball } });
const packument = (forEntry = entry, versions = {}) => ({ name: forEntry.name, versions });
const matchingPackument = (forEntry = entry, tarball, hash) =>
  packument(forEntry, { [forEntry.version]: version(forEntry, tarball, hash) });

async function withBundle(forEntry = entry, value = bytes, fn) {
  const directory = await mkdtemp(join(tmpdir(), "registry-publication-test-"));
  try {
    await writeFile(join(directory, forEntry.filename), value);
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function registryFetch(body, tarballBytes = bytes, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith(".tgz")) return new Response(tarballBytes, { status: 200 });
    return response(200, body);
  };
}

test("absent version and exact version verification", async () => {
  assert.equal(await inspectRegistry(entry, { fetchImpl: registryFetch(packument()) }), "absent");
  assert.equal(
    await inspectRegistry(entry, { fetchImpl: registryFetch(matchingPackument()) }),
    "matching",
  );
});

test("matching package skips publishing without invoking publisher", async () => {
  await withBundle(entry, bytes, async (directory) => {
    let calls = 0;
    const result = await publishPackage(entry, {
      directory,
      fetchImpl: registryFetch(matchingPackument()),
      publishImpl: async () => {
        calls += 1;
      },
      sleep: async () => {},
    });
    assert.deepEqual(result, { status: "skipped", id: entry.id, version: entry.version });
    assert.equal(calls, 0);
  });
});

test("partial success replay skips the successful target in either ordering", async () => {
  const b = {
    ...entry,
    id: "github",
    name: "@cowork-os/cowork-os",
    registry: "https://npm.pkg.github.com",
  };
  for (const [first, second] of [
    [entry, b],
    [b, entry],
  ]) {
    await withBundle(first, bytes, async (firstDirectory) =>
      withBundle(second, bytes, async (secondDirectory) => {
        const directories = new Map([
          [first.id, firstDirectory],
          [second.id, secondDirectory],
        ]);
        const remote = new Map();
        const calls = [];
        let failSecond = true;
        const fetchFor = (e) => async (url) =>
          remote.has(e.id)
            ? String(url).endsWith(".tgz")
              ? new Response(bytes)
              : response(
                  200,
                  matchingPackument(e, `${e.registry}/${encodeURIComponent(e.name)}.tgz`),
                )
            : response(200, packument(e));
        const publishFor =
          (e) =>
          async ({ directory: d }) => {
            calls.push({ id: e.id, bytes: await readFile(join(d, e.filename)) });
            if (e.id === second.id && failSecond) {
              failSecond = false;
              throw new Error("second target failed");
            }
            remote.set(e.id, true);
          };
        await publishPackage(first, {
          directory: directories.get(first.id),
          fetchImpl: fetchFor(first),
          publishImpl: publishFor(first),
          sleep: async () => {},
        });
        await assert.rejects(
          () =>
            publishPackage(second, {
              directory: directories.get(second.id),
              fetchImpl: fetchFor(second),
              publishImpl: publishFor(second),
              sleep: async () => {},
            }),
          /Publication failed/,
        );
        await publishPackage(first, {
          directory: directories.get(first.id),
          fetchImpl: fetchFor(first),
          publishImpl: publishFor(first),
          sleep: async () => {},
        });
        await publishPackage(second, {
          directory: directories.get(second.id),
          fetchImpl: fetchFor(second),
          publishImpl: publishFor(second),
          sleep: async () => {},
        });
        assert.deepEqual(
          calls.map(({ id }) => id),
          [first.id, second.id, second.id],
        );
        assert.deepEqual(calls[1].bytes, bytes);
        assert.deepEqual(calls[2].bytes, bytes);
      }),
    );
  }
});

test("local size, checksum, and symlink failures precede network", async () => {
  for (const [value, expected] of [
    [otherBytes, /size does not match/],
    [Buffer.from("bad!!!"), /integrity does not match/],
  ]) {
    await withBundle(entry, value, async (directory) => {
      let network = 0;
      await assert.rejects(
        () =>
          publishPackage(entry, {
            directory,
            fetchImpl: async () => {
              network += 1;
            },
            publishImpl: async () => {},
          }),
        expected,
      );
      assert.equal(network, 0);
    });
  }
  const directory = await mkdtemp(join(tmpdir(), "registry-publication-symlink-"));
  try {
    await symlink(join(directory, "target"), join(directory, entry.filename));
    let network = 0;
    await assert.rejects(
      () =>
        publishPackage(entry, {
          directory,
          fetchImpl: async () => {
            network += 1;
          },
          publishImpl: async () => {},
        }),
      /symlink|Invalid local bundle filename/,
    );
    assert.equal(network, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remote metadata and downloaded bytes mismatches are rejected", async () => {
  await assert.rejects(
    () =>
      inspectRegistry(entry, {
        fetchImpl: registryFetch(
          packument(entry, { [entry.version]: { ...version(), name: "other" } }),
        ),
      }),
    /version does not match/,
  );
  await assert.rejects(
    () =>
      inspectRegistry(entry, {
        fetchImpl: registryFetch(
          packument(entry, { [entry.version]: { ...version(), version: "9.9.9" } }),
        ),
      }),
    /version does not match/,
  );
  await assert.rejects(
    () =>
      inspectRegistry(entry, {
        fetchImpl: registryFetch(matchingPackument(entry, undefined, integrity(otherBytes))),
      }),
    /version does not match/,
  );
  await assert.rejects(
    () =>
      inspectRegistry(entry, {
        fetchImpl: registryFetch(matchingPackument(), Buffer.from("bad!!!")),
      }),
    /integrity does not match/,
  );
  await assert.rejects(
    () => inspectRegistry(entry, { fetchImpl: registryFetch({ name: "other", versions: {} }) }),
    /malformed/,
  );
  await assert.rejects(
    () => inspectRegistry(entry, { fetchImpl: registryFetch({ name: entry.name, versions: [] }) }),
    /malformed/,
  );
});

test("HTTP errors and network errors never publish", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(
      () => inspectRegistry(entry, { fetchImpl: async () => response(status) }),
      new RegExp(`HTTP ${status}|indeterminate 404`),
    );
    await withBundle(entry, bytes, async (directory) => {
      let publishCalls = 0;
      await assert.rejects(
        () =>
          publishPackage(entry, {
            directory,
            fetchImpl: async () => response(status),
            publishImpl: async () => {
              publishCalls += 1;
            },
            sleep: async () => {},
          }),
        /HTTP|indeterminate|could not be verified/,
      );
      assert.equal(publishCalls, 0);
    });
  }
  await assert.rejects(
    () =>
      inspectRegistry(entry, {
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    /Registry request failed/,
  );
});

test("lost publish response succeeds after exact-match reverify", async () => {
  await withBundle(entry, bytes, async (directory) => {
    let published = false;
    let calls = 0;
    const fetchImpl = async (url) =>
      String(url).endsWith(".tgz")
        ? new Response(bytes)
        : response(200, published ? matchingPackument() : packument());
    const result = await publishPackage(entry, {
      directory,
      fetchImpl,
      publishImpl: async () => {
        calls += 1;
        published = true;
        throw new Error("lost response");
      },
      sleep: async () => {},
    });
    assert.equal(result.status, "published");
    assert.equal(calls, 1);
  });
});

test("failed publish makes one attempt and bounded verification retries", async () => {
  await withBundle(entry, bytes, async (directory) => {
    let publishes = 0;
    let fetches = 0;
    let sleeps = 0;
    await assert.rejects(
      () =>
        publishPackage(entry, {
          directory,
          fetchImpl: async () => {
            fetches += 1;
            return response(200, packument());
          },
          publishImpl: async () => {
            publishes += 1;
            throw new Error("publish failed");
          },
          sleep: async () => {
            sleeps += 1;
          },
        }),
      /Publication failed and could not be verified/,
    );
    assert.equal(publishes, 1);
    assert.equal(fetches, 6);
    assert.equal(sleeps, 4);
  });
});

test("eventual consistency verifies when matching version appears", async () => {
  await withBundle(entry, bytes, async (directory) => {
    let lookups = 0;
    const result = await publishPackage(entry, {
      directory,
      fetchImpl: async (url) => {
        if (String(url).endsWith(".tgz")) return new Response(bytes);
        lookups += 1;
        return response(200, lookups < 3 ? packument() : matchingPackument());
      },
      publishImpl: async () => {},
      sleep: async () => {},
    });
    assert.equal(result.status, "published");
    assert.equal(lookups, 3);
  });
});

test("auth is only sent to registry host and absent on off-host download redirect", async () => {
  const github = {
    ...entry,
    id: "github",
    name: "@cowork-os/cowork-os",
    registry: "https://npm.pkg.github.com",
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers });
    if (String(url).includes("codeload.github.com"))
      return response(302, undefined, {
        location: "https://github.com/cowork-os/cowork-os/archive/v1.2.3.tgz",
      });
    if (String(url).includes("github.com/cowork-os")) return new Response(bytes);
    return response(
      200,
      matchingPackument(github, "https://codeload.github.com/cowork-os/cowork-os/tar.gz/v1.2.3"),
    );
  };
  assert.equal(await inspectRegistry(github, { token: "secret", fetchImpl }), "matching");
  assert.equal(calls[0].headers.authorization, "Bearer secret");
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[2].headers.authorization, undefined);
});

test("GitHub package tarballs accept the package-container redirect host", async () => {
  const github = {
    ...entry,
    id: "github",
    name: "@cowork-os/cowork-os",
    registry: "https://npm.pkg.github.com",
  };
  const calls = [];
  const tarball = "https://npm.pkg.github.com/download/@cowork-os/cowork-os/1.2.3/pkg.tgz";
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers });
    if (String(url) === tarball)
      return response(302, undefined, {
        location: "https://pkg-containers.githubusercontent.com/ghcr1/blobs/pkg.tgz",
      });
    if (String(url).includes("pkg-containers.githubusercontent.com")) return new Response(bytes);
    return response(200, matchingPackument(github, tarball));
  };

  assert.equal(await inspectRegistry(github, { token: "secret", fetchImpl }), "matching");
  assert.equal(calls[0].headers.authorization, "Bearer secret");
  assert.equal(calls[1].headers.authorization, "Bearer secret");
  assert.equal(calls[2].headers.authorization, undefined);
});

test("GitHub package tarballs accept the npm package redirect host", async () => {
  const github = {
    ...entry,
    id: "github",
    name: "@cowork-os/cowork-os",
    registry: "https://npm.pkg.github.com",
  };
  const tarball = "https://npm.pkg.github.com/download/@cowork-os/cowork-os/1.2.3/pkg.tgz";
  const fetchImpl = async (url) => {
    if (String(url) === tarball)
      return response(302, undefined, {
        location: "https://pkg-npm.githubusercontent.com/download/pkg.tgz",
      });
    if (String(url).includes("pkg-npm.githubusercontent.com")) return new Response(bytes);
    return response(200, matchingPackument(github, tarball));
  };

  assert.equal(await inspectRegistry(github, { token: "secret", fetchImpl }), "matching");
});

test("malicious registry target is rejected before network", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      inspectRegistry(
        { ...entry, registry: "https://evil.example" },
        {
          fetchImpl: async () => {
            calls += 1;
          },
        },
      ),
    /trusted|unsupported|allowlist|registry/i,
  );
  assert.equal(calls, 0);
});

test("default publisher uses an isolated npm config and exact publish flags", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "registry-publication-fake-npm-"));
  const captureFile = join(fakeBin, "capture.json");
  const fakeNpm = join(fakeBin, "npm");
  await writeFile(
    fakeNpm,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const out = process.env.COWORK_CAPTURE_FILE;",
      "const npmrc = process.env.NPM_CONFIG_USERCONFIG;",
      "fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), npmrc, npmrcText: fs.readFileSync(npmrc, 'utf8'), token: process.env.NODE_AUTH_TOKEN }));",
    ].join("\n"),
  );
  await chmod(fakeNpm, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath || ""}`;
  process.env.COWORK_CAPTURE_FILE = captureFile;
  try {
    await withBundle(entry, bytes, async (directory) => {
      let lookups = 0;
      const result = await publishPackage(entry, {
        directory,
        token: "private-token",
        fetchImpl: async (url) => {
          if (String(url).endsWith(".tgz")) return new Response(bytes);
          lookups += 1;
          return response(200, lookups === 1 ? packument() : matchingPackument());
        },
        sleep: async () => {},
      });
      assert.equal(result.status, "published");
      const capture = JSON.parse(await readFile(captureFile, "utf8"));
      assert.equal(capture.token, "private-token");
      assert.notEqual(capture.cwd, directory);
      assert.equal(capture.argv[0], "publish");
      assert.equal(capture.argv[1], join(directory, entry.filename));
      assert.deepEqual(capture.argv.slice(2), [
        "--registry",
        entry.registry,
        "--ignore-scripts",
        "--access",
        "public",
        "--tag",
        "latest",
      ]);
      assert.match(
        capture.npmrcText,
        new RegExp(`//${new URL(entry.registry).host}/:_authToken=\\$\\{NODE_AUTH_TOKEN\\}`),
      );
      assert.doesNotMatch(capture.npmrcText, /private-token/);
      await assert.rejects(() => readFile(capture.npmrc), /ENOENT/);
    });
  } finally {
    process.env.PATH = oldPath;
    delete process.env.COWORK_CAPTURE_FILE;
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("GitHub Packages publisher leaves access mode at the registry default", async () => {
  const githubEntry = {
    ...entry,
    id: "github",
    name: "@cowork-os/cowork-os",
    registry: "https://npm.pkg.github.com",
  };
  const fakeBin = await mkdtemp(join(tmpdir(), "registry-publication-github-npm-"));
  const captureFile = join(fakeBin, "capture.json");
  const fakeNpm = join(fakeBin, "npm");
  await writeFile(
    fakeNpm,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.COWORK_CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(2) }));",
    ].join("\n"),
  );
  await chmod(fakeNpm, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath || ""}`;
  process.env.COWORK_CAPTURE_FILE = captureFile;
  try {
    await withBundle(githubEntry, bytes, async (directory) => {
      let lookups = 0;
      const result = await publishPackage(githubEntry, {
        directory,
        token: "private-token",
        fetchImpl: async (url) => {
          if (String(url).endsWith(".tgz")) return new Response(bytes);
          lookups += 1;
          return response(
            200,
            lookups === 1
              ? packument(githubEntry)
              : matchingPackument(
                  githubEntry,
                  `${githubEntry.registry}/@cowork-os/cowork-os/-/cowork-os.tgz`,
                ),
          );
        },
        sleep: async () => {},
      });
      assert.equal(result.status, "published");
      const capture = JSON.parse(await readFile(captureFile, "utf8"));
      assert.deepEqual(capture.argv.slice(2), [
        "--registry",
        githubEntry.registry,
        "--ignore-scripts",
        "--tag",
        "latest",
      ]);
    });
  } finally {
    process.env.PATH = oldPath;
    delete process.env.COWORK_CAPTURE_FILE;
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("CLI verify rejects an absent package", async () => {
  await assert.rejects(
    () =>
      runCli({
        argv: ["node", "registry-publication.mjs", "verify"],
        env: { RELEASE_BUNDLE_DIR: "release", RELEASE_TARGET: "npm" },
        fetchImpl: async () => response(200, packument()),
        readBundleImpl: async () => ({ packages: [entry] }),
      }),
    /Verification failed for npm/,
  );
});
