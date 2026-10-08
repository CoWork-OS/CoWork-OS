# Infrastructure tools discontinuation

**Decision:** Discontinue the built-in Infrastructure tools as of 2026-10-08.

The Infrastructure tools gave the agent native cloud sandboxes through E2B, domain registration and DNS through Namecheap, a USDC wallet on Base, x402 machine payments and an optional Coinbase Agentic remote signer, with a settings page under **Settings > Integrations > Infrastructure** and a wallet balance in the sidebar footer. A crypto wallet and a domain registrar are a liability without a product story, and they sit far from the task workspace, access profiles, Bots and Automations we are focusing on. Sandboxed code execution stays available through the regular shell, Docker and macOS sandboxes and the `execute_code` tool.

This decision removes the `cloud_sandbox_*`, `domain_*`, `wallet_*`, `x402_*` and `infra_status` agent tools, the Infrastructure settings sub-tab, the sidebar wallet badge, the `infra:*` IPC channels and shared types, the executor's infrastructure prompt section, the `e2b` and `ethers` dependencies and the Coinbase Agentic Signer contract document. The approval and spend-limit guard for an MCP server's own `x402_fetch` tool (`COWORK_PAYMENT_LIMIT_USD`) is unrelated to these tools and stays.

**Upgrade data handling:** On first start of a release containing this change, CoWork OS deletes the `infra` settings row (API keys for E2B and Namecheap, payment limits, category toggles) from the active profile database. The same cleanup runs if an older database is later copied into the profile. The encrypted wallet private key is **not** deleted: it stays in the profile database under the `infra-wallet` category (or `conway-wallet` for keys created before the rename), encrypted with the OS keychain, so funds are not lost. There is no longer an in-app way to read it. If you hold USDC in the built-in wallet, move it to another wallet **before** upgrading, or keep a copy of the previous release to export it. Revoke the E2B and Namecheap API keys in those services if you no longer use them.

Historical release notes describe what shipped at the time and are superseded by this decision for current product availability.
