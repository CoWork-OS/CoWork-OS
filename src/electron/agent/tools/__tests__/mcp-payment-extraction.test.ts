import { describe, expect, it } from "vitest";
import type { MCPTool } from "../../../mcp/types";
import { extractPaymentAmountFromX402Tool, getMcpPaymentLimitError } from "../registry";

describe("extractPaymentAmountFromX402Tool", () => {
  const rootAmountTool: MCPTool = {
    name: "x402_fetch",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        maxAmount: { type: "number" },
      },
    },
  };

  const nestedRequestTool: MCPTool = {
    name: "x402_fetch",
    inputSchema: {
      type: "object",
      properties: {
        request: {
          type: "object",
          properties: {
            amount: { type: "number" },
          },
        },
      },
    },
  };

  it("extracts amount from x402 tool root amount field", () => {
    expect(extractPaymentAmountFromX402Tool({ amount: 12.5 }, rootAmountTool)).toBe(12.5);
  });

  it("extracts maxAmount from x402 tool root maxAmount field", () => {
    expect(extractPaymentAmountFromX402Tool({ maxAmount: "50" }, rootAmountTool)).toBe(50);
  });

  it("extracts amount from nested request.amount when schema defines it", () => {
    expect(
      extractPaymentAmountFromX402Tool({ request: { amount: "75.25" } }, nestedRequestTool),
    ).toBe(75.25);
  });

  it("does not read unrelated value fields without an amount path", () => {
    const toolWithoutAmountSchema: MCPTool = {
      name: "x402_fetch",
      inputSchema: {
        type: "object",
        properties: {
          metadata: {
            type: "object",
            properties: {
              value: { type: "number" },
            },
          },
        },
      },
    };

    expect(
      extractPaymentAmountFromX402Tool(
        { value: 500, metadata: { value: 500 } },
        toolWithoutAmountSchema,
      ),
    ).toBe(null);
  });

  it("returns null when tool schema is missing", () => {
    expect(extractPaymentAmountFromX402Tool({ amount: 10 }, undefined)).toBe(null);
  });

  it("ignores schemas not named x402_fetch", () => {
    const nonPaymentTool: MCPTool = {
      name: "other_tool",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
        },
      },
    };

    expect(extractPaymentAmountFromX402Tool({ amount: 99 }, nonPaymentTool)).toBe(null);
  });

  it("returns default cap error when amount is over safety limit", () => {
    const amountTool: MCPTool = {
      name: "x402_fetch",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
        },
      },
    };
    expect(getMcpPaymentLimitError({ amount: 150 }, amountTool)).toMatch(
      /MCP payment amount is above safety cap/,
    );
  });

  it("returns configured cap error when amount exceeds env override", () => {
    const amountTool: MCPTool = {
      name: "x402_fetch",
      inputSchema: {
        type: "object",
        properties: {
          amount: { type: "number" },
        },
      },
    };
    const previous = process.env.COWORK_PAYMENT_LIMIT_USD;
    process.env.COWORK_PAYMENT_LIMIT_USD = "50";

    try {
      expect(getMcpPaymentLimitError({ amount: 75 }, amountTool)).toMatch(
        /exceeds configured cap of 50/,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.COWORK_PAYMENT_LIMIT_USD;
      } else {
        process.env.COWORK_PAYMENT_LIMIT_USD = previous;
      }
    }
  });

  it("allows x402 amount within limits", () => {
    const amountTool: MCPTool = {
      name: "x402_fetch",
      inputSchema: {
        type: "object",
        properties: {
          maxAmount: { type: "number" },
        },
      },
    };

    const previous = process.env.COWORK_PAYMENT_LIMIT_USD;
    process.env.COWORK_PAYMENT_LIMIT_USD = "75";

    try {
      expect(getMcpPaymentLimitError({ maxAmount: 50 }, amountTool)).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.COWORK_PAYMENT_LIMIT_USD;
      } else {
        process.env.COWORK_PAYMENT_LIMIT_USD = previous;
      }
    }
  });
});
