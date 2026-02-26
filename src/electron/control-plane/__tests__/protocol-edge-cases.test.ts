/**
 * Edge Case Tests for WebSocket Control Plane Protocol
 */

import { describe, it, expect } from "vitest";
import {
  parseFrame,
  serializeFrame,
  createRequestFrame,
  createResponseFrame,
  createErrorResponse,
  createEventFrame,
  FrameType as _FrameType,
  ErrorCodes,
} from "../protocol";

describe("parseFrame edge cases", () => {
  describe("malformed JSON", () => {
    it("should handle empty string", () => {
      expect(parseFrame("")).toBeNull();
    });

    it("should handle whitespace only", () => {
      expect(parseFrame("   ")).toBeNull();
    });

    it("should handle truncated JSON", () => {
      expect(parseFrame('{"type":"req"')).toBeNull();
    });

    it("should handle nested invalid JSON", () => {
      expect(parseFrame('{"type":"req","params":invalid}')).toBeNull();
    });

    it("should handle array at root", () => {
      expect(parseFrame("[1, 2, 3]")).toBeNull();
    });

    it("should handle primitive values", () => {
      expect(parseFrame("42")).toBeNull();
      expect(parseFrame("true")).toBeNull();
      expect(parseFrame('"string"')).toBeNull();
    });
  });

  describe("type field validation", () => {
    it("should reject missing type", () => {
      expect(parseFrame(JSON.stringify({ id: "test", method: "ping" }))).toBeNull();
    });

    it("should reject null type", () => {
      expect(parseFrame(JSON.stringify({ type: null, id: "test", method: "ping" }))).toBeNull();
    });

    it("should reject number type", () => {
      expect(parseFrame(JSON.stringify({ type: 123, id: "test", method: "ping" }))).toBeNull();
    });

    it("should reject object type", () => {
      expect(parseFrame(JSON.stringify({ type: {}, id: "test", method: "ping" }))).toBeNull();
    });

    it("should reject array type", () => {
      expect(parseFrame(JSON.stringify({ type: [], id: "test", method: "ping" }))).toBeNull();
    });

    it("should reject unknown type string", () => {
      expect(parseFrame(JSON.stringify({ type: "unknown", id: "test" }))).toBeNull();
      expect(
        parseFrame(JSON.stringify({ type: "request", id: "test", method: "ping" })),
      ).toBeNull();
      expect(parseFrame(JSON.stringify({ type: "response", id: "test", ok: true }))).toBeNull();
    });
  });

  describe("request frame validation", () => {
    it("should reject non-string id", () => {
      expect(parseFrame(JSON.stringify({ type: "req", id: 123, method: "ping" }))).toBeNull();
      expect(parseFrame(JSON.stringify({ type: "req", id: null, method: "ping" }))).toBeNull();
      expect(parseFrame(JSON.stringify({ type: "req", id: {}, method: "ping" }))).toBeNull();
    });

    it("should reject non-string method", () => {
      expect(parseFrame(JSON.stringify({ type: "req", id: "test", method: 123 }))).toBeNull();
      expect(parseFrame(JSON.stringify({ type: "req", id: "test", method: null }))).toBeNull();
    });

    it("should reject whitespace-only id", () => {
      // The protocol trims whitespace and rejects empty strings
      const frame = parseFrame(JSON.stringify({ type: "req", id: "   ", method: "ping" }));
      expect(frame).toBeNull();
    });

    it("should reject whitespace-only method", () => {
      // The protocol trims whitespace and rejects empty strings
      const frame = parseFrame(JSON.stringify({ type: "req", id: "test", method: "   " }));
      expect(frame).toBeNull();
    });

    it("should accept valid params object", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "req",
          id: "test",
          method: "ping",
          params: { nested: { deep: true } },
        }),
      );
      expect(frame).not.toBeNull();
      expect(frame?.type).toBe("req");
    });

    it("should accept params array", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "req",
          id: "test",
          method: "ping",
          params: [1, 2, 3],
        }),
      );
      expect(frame).not.toBeNull();
    });
  });

  describe("response frame validation", () => {
    it("should reject non-boolean ok", () => {
      expect(parseFrame(JSON.stringify({ type: "res", id: "test", ok: "true" }))).toBeNull();
      expect(parseFrame(JSON.stringify({ type: "res", id: "test", ok: 1 }))).toBeNull();
      expect(parseFrame(JSON.stringify({ type: "res", id: "test", ok: null }))).toBeNull();
    });

    it("should reject missing ok", () => {
      expect(parseFrame(JSON.stringify({ type: "res", id: "test" }))).toBeNull();
    });

    it("should accept response with error object", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "res",
          id: "test",
          ok: false,
          error: {
            code: "TEST_ERROR",
            message: "Test message",
            details: { field: "value" },
          },
        }),
      );
      expect(frame).not.toBeNull();
      expect(frame?.type).toBe("res");
    });

    it("should accept response without payload", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "res",
          id: "test",
          ok: true,
        }),
      );
      expect(frame).not.toBeNull();
    });
  });

  describe("event frame validation", () => {
    it("should reject non-string event", () => {
      expect(parseFrame(JSON.stringify({ type: "event", event: 123 }))).toBeNull();
      expect(parseFrame(JSON.stringify({ type: "event", event: null }))).toBeNull();
    });

    it("should reject missing event", () => {
      expect(parseFrame(JSON.stringify({ type: "event" }))).toBeNull();
    });

    it("should accept event with seq and stateVersion", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "event",
          event: "test",
          payload: { data: "test" },
          seq: 42,
          stateVersion: "v1.2.3",
        }),
      );
      expect(frame).not.toBeNull();
      if (frame?.type === "event") {
        expect(frame.seq).toBe(42);
        expect(frame.stateVersion).toBe("v1.2.3");
      }
    });
  });

  describe("large payloads", () => {
    it("should handle large params object", () => {
      const largeParams: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) {
        largeParams[`key${i}`] = `value${i}`;
      }

      const frame = parseFrame(
        JSON.stringify({
          type: "req",
          id: "test",
          method: "bulk",
          params: largeParams,
        }),
      );

      expect(frame).not.toBeNull();
    });

    it("should handle deeply nested objects", () => {
      let nested: Any = { value: "deep" };
      for (let i = 0; i < 50; i++) {
        nested = { level: i, child: nested };
      }

      const frame = parseFrame(
        JSON.stringify({
          type: "req",
          id: "test",
          method: "deep",
          params: nested,
        }),
      );

      expect(frame).not.toBeNull();
    });
  });

  describe("special characters", () => {
    it("should handle unicode in id", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "req",
          id: "test-\u00e9\u00e0\u00fc-id",
          method: "ping",
        }),
      );
      expect(frame).not.toBeNull();
    });

    it("should handle unicode in method", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "req",
          id: "test",
          method: "méthode.test",
        }),
      );
      expect(frame).not.toBeNull();
    });

    it("should handle unicode in event", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "event",
          event: "événement.créé",
        }),
      );
      expect(frame).not.toBeNull();
    });

    it("should handle newlines in string values", () => {
      const frame = parseFrame(
        JSON.stringify({
          type: "req",
          id: "test",
          method: "test",
          params: { message: "line1\nline2\nline3" },
        }),
      );
      expect(frame).not.toBeNull();
    });
  });
});

describe("serializeFrame edge cases", () => {
  it("should handle circular reference prevention", () => {
    // serializeFrame should not throw on valid frames
    const frame = {
      type: "req" as const,
      id: "test",
      method: "ping",
      params: { a: 1, b: 2 },
    };
    expect(() => serializeFrame(frame)).not.toThrow();
  });

  it("should serialize undefined values correctly", () => {
    const frame = {
      type: "res" as const,
      id: "test",
      ok: true,
      payload: undefined,
    };
    const json = serializeFrame(frame);
    const parsed = JSON.parse(json);
    expect(parsed.payload).toBeUndefined();
  });

  it("should handle null values in params", () => {
    const frame = {
      type: "req" as const,
      id: "test",
      method: "test",
      params: { value: null, nested: { also: null } },
    };
    const json = serializeFrame(frame);
    const parsed = JSON.parse(json);
    expect(parsed.params.value).toBeNull();
    expect(parsed.params.nested.also).toBeNull();
  });
});

describe("createRequestFrame edge cases", () => {
  it("should generate unique IDs for rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const frame = createRequestFrame("test");
      ids.add(frame.id);
    }
    expect(ids.size).toBe(100);
  });

  it("should handle empty string method", () => {
    // The create function doesn't validate, parseFrame would reject this
    const frame = createRequestFrame("");
    expect(frame.method).toBe("");
  });

  it("should handle very long method names", () => {
    const longMethod = "a".repeat(1000);
    const frame = createRequestFrame(longMethod);
    expect(frame.method).toBe(longMethod);
  });
});

describe("createResponseFrame edge cases", () => {
  it("should handle empty string id", () => {
    const frame = createResponseFrame("", { result: "test" });
    expect(frame.id).toBe("");
    expect(frame.ok).toBe(true);
  });

  it("should handle complex payload", () => {
    const frame = createResponseFrame("test", {
      array: [1, 2, 3],
      nested: { a: { b: { c: true } } },
      date: "2024-01-01",
      nullValue: null,
    });
    expect(frame.payload).toEqual({
      array: [1, 2, 3],
      nested: { a: { b: { c: true } } },
      date: "2024-01-01",
      nullValue: null,
    });
  });
});

describe("createErrorResponse edge cases", () => {
  it("should handle all error codes", () => {
    const codes = Object.values(ErrorCodes);
    for (const code of codes) {
      const frame = createErrorResponse("test", code, "Test message");
      expect(frame.error?.code).toBe(code);
    }
  });

  it("should handle empty message", () => {
    const frame = createErrorResponse("test", ErrorCodes.INTERNAL_ERROR, "");
    expect(frame.error?.message).toBe("");
  });

  it("should handle complex details", () => {
    const frame = createErrorResponse("test", ErrorCodes.INVALID_PARAMS, "Invalid", {
      fields: ["field1", "field2"],
      constraints: { min: 0, max: 100 },
    });
    expect(frame.error?.details).toEqual({
      fields: ["field1", "field2"],
      constraints: { min: 0, max: 100 },
    });
  });
});

describe("createEventFrame edge cases", () => {
  it("should handle negative seq", () => {
    const frame = createEventFrame("test", undefined, -1);
    expect(frame.seq).toBe(-1);
  });

  it("should handle large seq", () => {
    const frame = createEventFrame("test", undefined, Number.MAX_SAFE_INTEGER);
    expect(frame.seq).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("should handle empty event name", () => {
    const frame = createEventFrame("");
    expect(frame.event).toBe("");
  });

  it("should handle undefined stateVersion", () => {
    const frame = createEventFrame("test", { data: 1 }, 0, undefined);
    expect(frame.stateVersion).toBeUndefined();
  });

  it("should handle empty stateVersion", () => {
    const frame = createEventFrame("test", { data: 1 }, 0, "");
    expect(frame.stateVersion).toBe("");
  });
});

describe("round-trip serialization", () => {
  it("should preserve request frame through serialize/parse", () => {
    const original = createRequestFrame("test.method", { param: "value" });
    const json = serializeFrame(original);
    const parsed = parseFrame(json);

    expect(parsed).toEqual(original);
  });

  it("should preserve response frame through serialize/parse", () => {
    const original = createResponseFrame("req-123", { result: "success" });
    const json = serializeFrame(original);
    const parsed = parseFrame(json);

    expect(parsed).toEqual(original);
  });

  it("should preserve error response through serialize/parse", () => {
    const original = createErrorResponse(
      "req-123",
      ErrorCodes.METHOD_FAILED,
      "Something went wrong",
      { trace: ["line1", "line2"] },
    );
    const json = serializeFrame(original);
    const parsed = parseFrame(json);

    expect(parsed).toEqual(original);
  });

  it("should preserve event frame through serialize/parse", () => {
    const original = createEventFrame("task.completed", { taskId: "abc" }, 42, "v1.0");
    const json = serializeFrame(original);
    const parsed = parseFrame(json);

    expect(parsed).toEqual(original);
  });
});
