import { describe, expect, it, vi } from "vitest";
import { configureNodeTlsTrust } from "../node-tls-trust";

function makeTlsApi() {
  return {
    getCACertificates: vi.fn((type: "default" | "system") =>
      type === "default" ? ["bundled-root", "custom-root"] : ["system-root", "bundled-root"],
    ),
    setDefaultCACertificates: vi.fn(),
  };
}

describe("configureNodeTlsTrust", () => {
  it("makes system roots available while retaining bundled and custom roots", () => {
    const tlsApi = makeTlsApi();
    const env = { UNRELATED: "kept" };

    expect(configureNodeTlsTrust({ platform: "darwin", env, execArgv: [], tlsApi })).toEqual({
      status: "configured",
      addedCertificates: 1,
    });
    expect(tlsApi.setDefaultCACertificates).toHaveBeenCalledExactlyOnceWith([
      "bundled-root",
      "custom-root",
      "system-root",
    ]);
    expect(env).toEqual({ UNRELATED: "kept" });
  });

  it.each(["linux", "win32"] as const)("keeps existing trust behavior on %s", (platform) => {
    const tlsApi = makeTlsApi();
    expect(configureNodeTlsTrust({ platform, env: {}, execArgv: [], tlsApi })).toEqual({
      status: "unchanged",
    });
    expect(tlsApi.getCACertificates).not.toHaveBeenCalled();
  });

  it.each([
    "--use-bundled-ca",
    "--use-openssl-ca",
    "--use-system-ca",
    "--no-use-system-ca",
    '"--use-bundled-ca"',
    "--use-system-ca=false",
  ])("preserves the explicit NODE_OPTIONS trust selection %s", (flag) => {
    const tlsApi = makeTlsApi();
    const env = { NODE_OPTIONS: `--max-old-space-size=4096 ${flag}` };
    expect(configureNodeTlsTrust({ platform: "darwin", env, execArgv: [], tlsApi })).toEqual({
      status: "unchanged",
    });
    expect(tlsApi.getCACertificates).not.toHaveBeenCalled();
    expect(env.NODE_OPTIONS).toBe(`--max-old-space-size=4096 ${flag}`);
  });

  it("honors CA selections passed directly to the runtime", () => {
    const tlsApi = makeTlsApi();
    configureNodeTlsTrust({ platform: "darwin", env: {}, execArgv: ["--use-bundled-ca"], tlsApi });
    expect(tlsApi.getCACertificates).not.toHaveBeenCalled();
  });

  it.each([
    { NODE_EXTRA_CA_CERTS: "/custom/root.pem" },
    { SSL_CERT_FILE: "/custom/root.pem" },
    { SSL_CERT_DIR: "/custom/certs" },
    { NODE_USE_SYSTEM_CA: "0" },
    { NODE_USE_SYSTEM_CA: "1" },
    { COWORK_DEV_USE_SYSTEM_CA: "0" },
  ])("preserves explicit trust environment %j", (env) => {
    const tlsApi = makeTlsApi();
    configureNodeTlsTrust({ platform: "darwin", env, execArgv: [], tlsApi });
    expect(tlsApi.getCACertificates).not.toHaveBeenCalled();
  });

  it.each([{ systemRoots: [] }, { systemRoots: ["bundled-root", "custom-root"] }])(
    "does not replace the default store when system roots add nothing: $systemRoots",
    ({ systemRoots }) => {
      const tlsApi = makeTlsApi();
      tlsApi.getCACertificates.mockImplementation((type) =>
        type === "default" ? ["bundled-root", "custom-root"] : systemRoots,
      );
      expect(configureNodeTlsTrust({ platform: "darwin", env: {}, execArgv: [], tlsApi })).toEqual({
        status: "unchanged",
      });
      expect(tlsApi.setDefaultCACertificates).not.toHaveBeenCalled();
    },
  );

  it("keeps existing trust when an older runtime lacks the API", () => {
    const tlsApi = { getCACertificates: vi.fn() };
    expect(configureNodeTlsTrust({ platform: "darwin", env: {}, execArgv: [], tlsApi })).toEqual({
      status: "unavailable",
    });
    expect(tlsApi.getCACertificates).not.toHaveBeenCalled();
  });

  it("keeps existing trust when loading the system store fails", () => {
    const tlsApi = makeTlsApi();
    tlsApi.getCACertificates.mockImplementation(() => {
      throw new Error("system store unavailable");
    });
    expect(configureNodeTlsTrust({ platform: "darwin", env: {}, execArgv: [], tlsApi })).toEqual({
      status: "unavailable",
    });
    expect(tlsApi.setDefaultCACertificates).not.toHaveBeenCalled();
  });

  it("handles rejection of CA configuration without changing verification settings", () => {
    const tlsApi = makeTlsApi();
    tlsApi.setDefaultCACertificates.mockImplementation(() => {
      throw new Error("invalid certificate");
    });
    const env = {};
    expect(configureNodeTlsTrust({ platform: "darwin", env, execArgv: [], tlsApi })).toEqual({
      status: "unavailable",
    });
    expect(env).toEqual({});
  });
});
