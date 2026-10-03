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

  // Local work that mentions a network library, a loopback URL or a search for
  // one must not be blocked as shell networking.
  it.each([
    'grep -rn "fetch(" src',
    "grep -rn fetch src/api",
    "rg axios src",
    "rg -n 'https://api.example.com' src",
    "ag requests lib",
    'git grep -n "socket" -- src',
    'git log -S "fetch(" --oneline',
    'git log --grep="retry fetch" --oneline',
    "cat src/api/fetch.ts",
    "ls src/socket",
    'git commit -m "fix: retry fetch on 503"',
    'git commit -am "docs: link https://example.com/guide"',
    'pytest -k "socket and timeout"',
    "python -m pytest -k socket tests",
    "npm test -- src/api/axios-client.test.ts",
    "sed -i 's#http://localhost:3000#http://localhost:4000#g' .env.example",
    "open http://127.0.0.1:5173/",
    "echo http://[::1]:8080 http://0.0.0.0:3000",
    "python3 scripts/build.py --check",
    'npm test -- "src/api/axios client.test.ts"',
    "chmod +x run.sh && ./run.sh",
    "ls helper.py && python3 helper.py",
    // An apostrophe in a comment must not make the command untokenizable.
    'grep -rn "fetch(" src # what\'s calling fetch',
  ])("does not classify the local command %s as network access", (command) => {
    expect(isLikelyNetworkShellCommand(command)).toBe(false);
  });

  // Real egress must stay classified as network access.
  it.each([
    "curl https://x",
    "wget https://x",
    "curl http://localhost:3000/health",
    `python -c "import requests; requests.get('https://x')"`,
    `python3 -c "import requests; requests.get(url)"`,
    [
      "python3 - <<'EOF'",
      "import urllib.request",
      "urllib.request.urlopen(url).read()",
      "EOF",
    ].join("\n"),
    `node -e "fetch('https://example.com')"`,
    `node -e "fetch(process.env.TARGET)"`,
    `echo "import socket; socket.create_connection((h, 80))" | python3`,
    "git clone https://github.com/a/b.git",
    "git clone git@github.com:a/b.git",
    "git -C vendor/lib fetch origin",
    "npm install",
    "pnpm fetch",
    "pip install x",
    "poetry add requests",
    "echo x | nc host 80",
    "echo hi > /dev/tcp/example.com/80",
    "exec 3<>/dev/tcp/10.0.0.1/80",
    `cat payload | python -c "import socket; socket.socket().connect((h, p))"`,
    `bash -lc "wget example.com/file"`,
    "/usr/bin/curl example.com",
    'grep "$(curl -s https://x)" notes.txt',
    'git commit -m "$(curl -s https://x)"',
    "rg --pre 'curl -s https://x' pattern",
    "node scripts/fetch-data.js",
    "echo http://localhost@evil.example/",
    "echo http://127.0.0.1.nip.io/",
    'echo "unterminated fetch',
    // A search tool that may not be the real one gets no masking.
    "alias grep=curl; grep https://x",
    "cp /usr/bin/curl ./grep && ./grep https://x",
    "PATH=/tmp/bin:$PATH grep https://x",
    "PATH+=:./bin; grep https://x",
    "source ./helpers.sh && grep https://x",
    // Heredoc bodies are code, not shell commands to mask.
    ["python3 - <<'EOF'", 'grep "https://evil.example/x"', "EOF"].join("\n"),
    // Only a bare loopback authority is exempt.
    "echo http://evil.example\\@localhost/",
    "echo http://user@localhost:3000/",
    // Scripts run through other runners keep their names in scope.
    "uv run fetch.py",
    "go run ./cmd/fetch",
    "java -cp lib Fetch",
    // Code handed to another command as a string.
    `eval "python3 -c 'import requests; requests.get(url)'"`,
    `watch -n 5 'python3 -c "import socket; socket.create_connection((h, 80))"'`,
    'source <(echo "requests.get(url)")',
    `alias sync-data='python3 -c "import requests; requests.get(u)"'; sync-data`,
    // A script written by the command and then run is code, not a data payload.
    [
      "tee helper.py <<'EOF'",
      "import requests, os",
      "requests.get(os.environ['TARGET'])",
      "EOF",
      "python3 helper.py",
    ].join("\n"),
    'echo "import requests; requests.get(u)" > helper.py && python3 helper.py',
    ["cat > fetcher.sh <<'EOF'", "curl https://example.com", "EOF", "sh ./fetcher.sh"].join("\n"),
    "printf '%s' 'import requests; requests.get(url)' | dd of=helper.py status=none && python3 helper.py",
    "echo 'import socket' | sponge helper.py; python3 ./helper.py",
  ])("keeps %s classified as network access", (command) => {
    expect(isLikelyNetworkShellCommand(command)).toBe(true);
  });

  it("does not let eval nesting beyond the recursion limit hide network code", () => {
    const wrapInEval = (command: string) =>
      `eval "${command.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    let command = 'python3 -c "import requests; requests.get(url)"';
    for (let layer = 0; layer < 6; layer += 1) {
      command = wrapInEval(command);
      expect(isLikelyNetworkShellCommand(command), `${layer + 1} eval layers`).toBe(true);
    }
  });
});
