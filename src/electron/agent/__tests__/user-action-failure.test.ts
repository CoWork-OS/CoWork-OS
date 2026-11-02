import { describe, expect, it } from "vitest";
import { isUserActionRequiredFailure } from "../user-action-failure";

describe("isUserActionRequiredFailure", () => {
  it("ignores failures that only resemble a blocker (#607)", () => {
    const recoverable = [
      // "author" is not "auth"
      "Failed to parse the author field in package.json",
      "Co-authored-by trailer is malformed",
      // a number that merely contains 429 is not an HTTP 429
      "SyntaxError at line 1429",
      "Processed 14290 rows before the crash",
      // "provided"/"provides" is not an instruction to provide something
      "The provided input was not valid JSON",
      "The helper provides a value for the path option",
      "",
    ];
    for (const reason of recoverable) {
      expect(isUserActionRequiredFailure(reason), reason).toBe(false);
    }
  });

  it("still recognises blockers only the user can clear", () => {
    const blockers = [
      "approval denied",
      "API key required",
      "Please reconnect your Slack integration",
      "401 Unauthorized",
      "authentication failed",
      "rate limit exceeded",
      "Action required: confirm the deployment target",
      "HTTP 429 Too Many Requests",
      "upstream returned 429",
      "OAuth token expired, please sign in again",
      "Please provide the path to the config file",
      "Provide a value for the API_BASE input",
      "permission denied",
      "Authorisation failed for the Slack workspace",
      "Not authorised to access this resource",
      "Please reauthenticate to continue",
      "reauthorize the GitHub app",
      "auth_token missing",
      "Error: authToken is invalid",
      "UNAUTHENTICATED",
      "login_required",
      "Provide values for the required inputs",
      "Please provide the paths to both files",
      "error_429",
      "HTTP_429 rate-limited",
    ];
    for (const reason of blockers) {
      expect(isUserActionRequiredFailure(reason), reason).toBe(true);
    }
  });
});
