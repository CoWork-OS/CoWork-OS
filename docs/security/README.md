# CoWork OS Security Documentation

This documentation covers the security architecture of CoWork OS, an AI-powered task automation platform.

## Contents

1. [Access Profiles](../access-profiles.md) - Canonical task-level sandbox, approval, reviewer, network, filesystem, and domain controls
2. [Security Model](./security-model.md) - Overview of the security architecture
3. [Trust Boundaries](./trust-boundaries.md) - Understanding workspace, channel, and network boundaries
4. [Self-Modification Gates](./self-modification-gates.md) - Why only the user can change the agent's persona, rules and skills
5. [Configuration Guide](./configuration-guide.md) - How to configure security settings
6. [Best Practices](./best-practices.md) - Recommended security settings and practices
7. [Codex Security Scans](../codex-security-scans.md) - Repository, diff, and deep-scan workflow containment
8. [Agent Security with Numbat](../agent-security-numbat.md) - Optional monitor/enforce decisions, policy, operations, and retention

## Quick Start

CoWork OS is designed with security in mind. By default:

- **Pairing mode** is enabled for all channels - users must enter a pairing code to connect
- **Access profiles** provide the task-level choice between Ask for approval, Approve for me, Full access, and validated custom profiles
- **Sandboxing** isolates command execution using macOS sandbox-exec or Docker
- **Tool restrictions** prevent sensitive operations in shared contexts (group chats)
- **Self-modification gates** keep persona, behavioral-rule and skill changes in the user's hands: those tools open only on text the user typed, and saving a skill asks first
- **Approval and reviewer policies** govern sensitive actions inside the selected profile; hard guardrails and explicit denies always win
- **Numbat agent security** is disabled by default; when enabled, it can add restrictions but cannot grant permissions or suppress approvals
- **Control Plane exposure** is loopback-first; headless/managed deployments block raw public binds unless Tailscale, private container context, or an explicit break-glass override is configured

## Security Principles

1. **Defense in Depth** - Multiple layers of security controls
2. **Least Privilege** - Tools only have access to what the effective profile and policy allow
3. **Deny by Default** - Explicit allowlisting for access
4. **Audit Trail** - All messages and actions are logged

## Need Help?

- For security questions, see the [FAQ section](./best-practices.md#faq)
- To report a security issue, please email info@coworkosapp.com
