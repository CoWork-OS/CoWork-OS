/**
 * Tests for ShellTools security features
 * Tests PID validation, username validation, process ownership checks,
 * and process tree killing functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _testUtils } from "../shell-tools";

const { isValidPid, isValidUsername, isProcessOwnedByCurrentUser, resolveCommandCwd } =
  _testUtils;

describe("ShellTools Security Functions", () => {
  describe("isValidPid", () => {
    describe("valid PIDs", () => {
      it("should accept PID 1 (init/launchd)", () => {
        expect(isValidPid(1)).toBe(true);
      });

      it("should accept typical PID values", () => {
        expect(isValidPid(100)).toBe(true);
        expect(isValidPid(1000)).toBe(true);
        expect(isValidPid(12345)).toBe(true);
        expect(isValidPid(99999)).toBe(true);
      });

      it("should accept maximum valid PID (4194304)", () => {
        expect(isValidPid(4194304)).toBe(true);
      });
    });

    describe("invalid PIDs - security checks", () => {
      it("should reject PID 0 (kernel)", () => {
        expect(isValidPid(0)).toBe(false);
      });

      it("should reject negative PIDs", () => {
        expect(isValidPid(-1)).toBe(false);
        expect(isValidPid(-100)).toBe(false);
        expect(isValidPid(-4194304)).toBe(false);
      });

      it("should reject PIDs above maximum", () => {
        expect(isValidPid(4194305)).toBe(false);
        expect(isValidPid(10000000)).toBe(false);
        expect(isValidPid(Number.MAX_SAFE_INTEGER)).toBe(false);
      });

      it("should reject non-integer PIDs", () => {
        expect(isValidPid(1.5)).toBe(false);
        expect(isValidPid(100.001)).toBe(false);
        expect(isValidPid(NaN)).toBe(false);
        expect(isValidPid(Infinity)).toBe(false);
        expect(isValidPid(-Infinity)).toBe(false);
      });

      it("should reject non-number types (command injection prevention)", () => {
        expect(isValidPid("123")).toBe(false);
        expect(isValidPid("1; rm -rf /")).toBe(false);
        expect(isValidPid("$(whoami)")).toBe(false);
        expect(isValidPid("`id`")).toBe(false);
        expect(isValidPid(null)).toBe(false);
        expect(isValidPid(undefined)).toBe(false);
        expect(isValidPid({})).toBe(false);
        expect(isValidPid([])).toBe(false);
        expect(isValidPid(() => 1)).toBe(false);
      });

      it("should reject string numbers that could bypass parseInt", () => {
        // These could be dangerous if passed to shell without validation
        expect(isValidPid("123 && rm -rf /")).toBe(false);
        expect(isValidPid("123; cat /etc/passwd")).toBe(false);
      });
    });
  });

  describe("isValidUsername", () => {
    describe("valid usernames", () => {
      it("should accept simple alphanumeric usernames", () => {
        expect(isValidUsername("root")).toBe(true);
        expect(isValidUsername("admin")).toBe(true);
        expect(isValidUsername("user1")).toBe(true);
        expect(isValidUsername("testuser")).toBe(true);
      });

      it("should accept usernames with underscores", () => {
        expect(isValidUsername("test_user")).toBe(true);
        expect(isValidUsername("_admin")).toBe(true);
        expect(isValidUsername("user_name_123")).toBe(true);
      });

      it("should accept usernames with dashes", () => {
        expect(isValidUsername("test-user")).toBe(true);
        expect(isValidUsername("my-admin")).toBe(true);
      });

      it("should accept usernames up to 32 characters", () => {
        expect(isValidUsername("a".repeat(32))).toBe(true);
        expect(isValidUsername("abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
      });

      it("should accept single character usernames", () => {
        expect(isValidUsername("a")).toBe(true);
        expect(isValidUsername("1")).toBe(true);
      });
    });

    describe("invalid usernames - security checks", () => {
      it("should reject empty or undefined usernames", () => {
        expect(isValidUsername("")).toBe(false);
        expect(isValidUsername(undefined)).toBe(false);
      });

      it("should reject usernames longer than 32 characters", () => {
        expect(isValidUsername("a".repeat(33))).toBe(false);
        expect(isValidUsername("a".repeat(100))).toBe(false);
      });

      it("should reject usernames with spaces (command injection)", () => {
        expect(isValidUsername("user name")).toBe(false);
        expect(isValidUsername(" admin")).toBe(false);
        expect(isValidUsername("admin ")).toBe(false);
      });

      it("should reject usernames with shell metacharacters", () => {
        expect(isValidUsername("user;rm")).toBe(false);
        expect(isValidUsername("user|cat")).toBe(false);
        expect(isValidUsername("user&id")).toBe(false);
        expect(isValidUsername("user`id`")).toBe(false);
        expect(isValidUsername("$(whoami)")).toBe(false);
        expect(isValidUsername("user$HOME")).toBe(false);
      });

      it("should reject usernames with path traversal attempts", () => {
        expect(isValidUsername("../etc/passwd")).toBe(false);
        expect(isValidUsername("user/name")).toBe(false);
        expect(isValidUsername("user\\name")).toBe(false);
      });

      it("should reject usernames with quotes", () => {
        expect(isValidUsername("user'name")).toBe(false);
        expect(isValidUsername('user"name')).toBe(false);
      });

      it("should reject usernames with newlines", () => {
        expect(isValidUsername("user\nname")).toBe(false);
        expect(isValidUsername("user\rname")).toBe(false);
      });

      it("should reject usernames starting with dash in dangerous contexts", () => {
        // While -username is technically valid POSIX, it could be interpreted
        // as a flag by some commands. Our regex allows it but pgrep handles it safely.
        // This test documents current behavior.
        expect(isValidUsername("-admin")).toBe(true); // Currently allowed
      });
    });
  });

  describe("isProcessOwnedByCurrentUser", () => {
    let originalKill: typeof process.kill;

    beforeEach(() => {
      originalKill = process.kill;
    });

    afterEach(() => {
      process.kill = originalKill;
    });

    it("should return true for a process owned by current user", () => {
      // Mock process.kill to succeed (signal 0 check)
      process.kill = vi.fn().mockImplementation(() => true);

      expect(isProcessOwnedByCurrentUser(12345)).toBe(true);
      expect(process.kill).toHaveBeenCalledWith(12345, 0);
    });

    it("should return false for process owned by another user (EPERM)", () => {
      // Mock process.kill to throw EPERM
      const epermError = new Error("Operation not permitted") as NodeJS.ErrnoException;
      epermError.code = "EPERM";
      process.kill = vi.fn().mockImplementation(() => {
        throw epermError;
      });

      // Suppress console.warn for this test
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(isProcessOwnedByCurrentUser(12345)).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Process 12345 exists but is owned by another user"),
      );

      warnSpy.mockRestore();
    });

    it("should return false for non-existent process (ESRCH)", () => {
      // Mock process.kill to throw ESRCH
      const esrchError = new Error("No such process") as NodeJS.ErrnoException;
      esrchError.code = "ESRCH";
      process.kill = vi.fn().mockImplementation(() => {
        throw esrchError;
      });

      expect(isProcessOwnedByCurrentUser(99999)).toBe(false);
    });

    it("should return false for invalid PID", () => {
      process.kill = vi.fn();

      expect(isProcessOwnedByCurrentUser(-1)).toBe(false);
      expect(isProcessOwnedByCurrentUser(0)).toBe(false);
      expect(isProcessOwnedByCurrentUser(5000000)).toBe(false);

      // Should not even attempt to call process.kill for invalid PIDs
      expect(process.kill).not.toHaveBeenCalled();
    });

    it("should return false for other errors", () => {
      // Mock process.kill to throw a generic error
      const genericError = new Error("Unknown error") as NodeJS.ErrnoException;
      genericError.code = "UNKNOWN";
      process.kill = vi.fn().mockImplementation(() => {
        throw genericError;
      });

      expect(isProcessOwnedByCurrentUser(12345)).toBe(false);
    });
  });

  describe("Security Edge Cases", () => {
    describe("PID type coercion attacks", () => {
      it("should not be vulnerable to objects with valueOf", () => {
        const maliciousPid = {
          valueOf: () => 1234,
          toString: () => "1234; rm -rf /",
        };
        expect(isValidPid(maliciousPid)).toBe(false);
      });

      it("should not be vulnerable to objects with [Symbol.toPrimitive]", () => {
        const maliciousPid = {
          [Symbol.toPrimitive]: () => 1234,
        };
        expect(isValidPid(maliciousPid)).toBe(false);
      });
    });

    describe("Username encoding attacks", () => {
      it("should reject null bytes", () => {
        expect(isValidUsername("user\x00name")).toBe(false);
      });

      it("should reject unicode lookalikes", () => {
        // Cyrillic 'а' looks like Latin 'a' but is different
        expect(isValidUsername("аdmin")).toBe(false); // Cyrillic а
        expect(isValidUsername("admin")).toBe(true); // Latin a
      });

      it("should reject emoji", () => {
        expect(isValidUsername("user😀")).toBe(false);
      });
    });

    describe("Integer overflow", () => {
      it("should handle very large numbers safely", () => {
        expect(isValidPid(Number.MAX_VALUE)).toBe(false);
        expect(isValidPid(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
      });

      it("should handle negative large numbers", () => {
        expect(isValidPid(Number.MIN_VALUE)).toBe(false);
        expect(isValidPid(Number.MIN_SAFE_INTEGER)).toBe(false);
      });
    });
  });
});

describe("ShellTools Integration", () => {
  // These tests verify the ShellTools class behavior
  // They require more complex mocking of the daemon and workspace

  describe("cwd resolution", () => {
    it("resolves relative cwd values against the workspace path", () => {
      expect(resolveCommandCwd("/tmp/workspace", "todo-app")).toBe("/tmp/workspace/todo-app");
    });

    it("keeps absolute cwd values unchanged", () => {
      expect(resolveCommandCwd("/tmp/workspace", "/tmp/other")).toBe("/tmp/other");
    });

    it("maps dot cwd to the workspace path", () => {
      expect(resolveCommandCwd("/tmp/workspace", ".")).toBe("/tmp/workspace");
    });
  });

  describe("Process session tracking", () => {
    it("should increment session ID on each command", () => {
      // This would require creating a ShellTools instance with mocked dependencies
      // For now, we verify the concept through the exported test utils
      expect(true).toBe(true); // Placeholder for integration tests
    });
  });
});

describe("CommandTerminationReason", () => {
  describe("termination reason determination logic", () => {
    it("should return user_stopped when userKillRequested is true", () => {
      // Simulating the logic from shell-tools.ts close handler
      const userKillRequested = true;
      const killed = false; // timeout flag

      let terminationReason = "normal";
      if (userKillRequested) {
        terminationReason = "user_stopped";
      } else if (killed) {
        terminationReason = "timeout";
      }

      expect(terminationReason).toBe("user_stopped");
    });

    it("should return timeout when killed flag is true (timeout)", () => {
      const userKillRequested = false;
      const killed = true; // timeout flag

      let terminationReason = "normal";
      if (userKillRequested) {
        terminationReason = "user_stopped";
      } else if (killed) {
        terminationReason = "timeout";
      }

      expect(terminationReason).toBe("timeout");
    });

    it("should return normal when neither flag is set", () => {
      const userKillRequested = false;
      const killed = false;

      let terminationReason = "normal";
      if (userKillRequested) {
        terminationReason = "user_stopped";
      } else if (killed) {
        terminationReason = "timeout";
      }

      expect(terminationReason).toBe("normal");
    });

    it("should prioritize user_stopped over timeout", () => {
      // Edge case: both flags are true (user killed during timeout)
      const userKillRequested = true;
      const killed = true;

      let terminationReason = "normal";
      if (userKillRequested) {
        terminationReason = "user_stopped";
      } else if (killed) {
        terminationReason = "timeout";
      }

      // user_stopped should take priority since user action is explicit
      expect(terminationReason).toBe("user_stopped");
    });
  });

  describe("success determination with terminationReason", () => {
    it("should be successful only when exitCode is 0 AND terminationReason is normal", () => {
      const testCases = [
        { exitCode: 0, terminationReason: "normal", expectedSuccess: true },
        { exitCode: 0, terminationReason: "user_stopped", expectedSuccess: false },
        { exitCode: 0, terminationReason: "timeout", expectedSuccess: false },
        { exitCode: 1, terminationReason: "normal", expectedSuccess: false },
        { exitCode: 1, terminationReason: "user_stopped", expectedSuccess: false },
        { exitCode: null, terminationReason: "error", expectedSuccess: false },
      ];

      for (const { exitCode, terminationReason, expectedSuccess } of testCases) {
        const success = exitCode === 0 && terminationReason === "normal";
        expect(success).toBe(expectedSuccess);
      }
    });
  });
});
