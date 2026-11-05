import { describe, expect, it } from "vitest";
import { remoteGatewayUrlProblem } from "../remote-gateway-url";

describe("remoteGatewayUrlProblem", () => {
  it("accepts WebSocket and HTTP gateway URLs", () => {
    expect(remoteGatewayUrlProblem("wss://mini.tail1234.ts.net:18789")).toBeNull();
    expect(remoteGatewayUrlProblem(" ws://127.0.0.1:18789 ")).toBeNull();
    expect(remoteGatewayUrlProblem("https://gateway.example.com")).toBeNull();
  });

  it("explains an empty, malformed or non-gateway URL", () => {
    expect(remoteGatewayUrlProblem("  ")).toMatch(/Enter the device's gateway URL/);
    expect(remoteGatewayUrlProblem("not a url")).toMatch(/full gateway URL/);
    expect(remoteGatewayUrlProblem("mini.local:18789")).toMatch(/must start with ws:\/\//);
    expect(remoteGatewayUrlProblem("ftp://mini.local")).toMatch(/must start with ws:\/\//);
  });
});
