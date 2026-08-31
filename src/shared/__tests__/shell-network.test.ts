import { describe, expect, it } from "vitest";
import { isLikelyNetworkShellCommand } from "../shell-network";

describe("isLikelyNetworkShellCommand", () => {
  it("does not classify a documentation URL in a cat file heredoc as network access", () => {
    const command = [
      "mkdir -p notes && cat > notes/checklist.md <<'EOF'",
      "# Setup",
      "Clone from https://github.com/CoWork-OS/CoWork-OS.git",
      "EOF",
    ].join("\n");

    expect(isLikelyNetworkShellCommand(command)).toBe(false);
  });

  it("does not classify a URL in a Python write_text literal as network access", () => {
    const command =
      'python3 -c \'from pathlib import Path; Path("notes.md").write_text("""Docs: https://example.com/reference""")\'';

    expect(isLikelyNetworkShellCommand(command)).toBe(false);
  });

  it("keeps executable Python network access blocked", () => {
    const command = [
      "python3 - <<'PY'",
      "from urllib.request import urlopen",
      "print(urlopen('https://example.com').read())",
      "PY",
    ].join("\n");

    expect(isLikelyNetworkShellCommand(command)).toBe(true);
  });

  it("keeps a heredoc piped to a shell classified as network access", () => {
    const command = ["cat <<'EOF' | sh", "curl https://example.com", "EOF"].join("\n");

    expect(isLikelyNetworkShellCommand(command)).toBe(true);
  });
});
