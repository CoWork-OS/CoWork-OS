# Priorities

## Now (This Sprint)

1. **Release stabilization** — keep `main` green after the latest successful main CI runs, verify `npm run dev` startup, run targeted checks before shipping, and resolve any P0/P1 or TypeScript blockers.
2. **Dependency and PR triage** — prioritize PR #167, the large Dependabot minor/patch dependency batch, because its failing `Tests / Run tests` CI job blocks dependency/security posture and release stabilization. Reproduce the failure, identify the breaking dependency, then fix or split the batch before merging.
3. **GitHub issue routing** — triage the current open real issues: #182 Chinese language support and #157 execution-mode complexity/mode-switching bug as P1/P2, then #144 Windows release/git workflow and #134 Linux desktop GUI release as distribution/community readiness follow-ups.
4. **Documentation completeness** — keep Dreaming, Workflow Intelligence, Heartbeat, managed-agent, packaging, changelog, and public adoption stats docs aligned with shipped code. `docs/public-adoption-stats.md` now documents that current public metrics are acquisition/download-intent signals only, not active usage, retention, task success, telemetry, prompts, files, emails, or in-app content.
5. **Community readiness** — answer/close remaining open discussion threads, add maintainer responses for Windows/Linux distribution requests (#144/#134), keep contributing/issue/PR templates welcoming, and route unresolved community asks into durable next actions.
6. **Dreaming backend readiness** — validate the backend-first Dreaming implementation, preserve review-first wording, and avoid claiming a renderer review queue until it exists.

## Next (This Month)

7. **Distribution push** — publish a launch post, create a demo video, submit to Hacker News and relevant subreddits.
8. **Partnership outreach** — identify 5 complementary open-source projects and initiate conversations.
9. **Plugin ecosystem growth** — document the plugin authoring workflow and publish 2-3 example community packs.

## Later (This Quarter)

10. **Enterprise features** — SSO integration, audit logging, multi-tenant admin policies.
11. **Marketplace** — launch a curated marketplace for community plugin packs.
12. **Sustainability** — establish a sponsorship program and explore enterprise licensing options.

## Heartbeat Notes

- Heartbeat run id: `2e973eac-c4a0-4fdd-8bd5-af36d5cb64e6`
- Update basis: pending-work heartbeat found 4 open real issues, 5 open PRs, and a release-stabilization blocker in Dependabot PR #167 with failing tests. Sprint context therefore requires updating priorities toward CI/dependency triage before broader community/distribution work.
