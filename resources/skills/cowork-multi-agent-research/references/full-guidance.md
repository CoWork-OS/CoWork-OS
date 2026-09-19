# CoWork OS Multi-Agent Research — Full Guidance

## PROGRESS.md Template

Create this file at the workspace root if it does not exist:

```markdown
# Multi-Agent System Research — Progress

## Completed Topics

| Date                                        | Topic | File |
| ------------------------------------------- | ----- | ---- |
| (empty — add rows as you complete research) |

## Queue (Next Topics)

1. [Topic 1 — e.g., "Hierarchical multi-agent orchestration patterns"]
2. [Topic 2 — e.g., "Agent handoff and context transfer"]
3. [Topic 3 — e.g., "Collaborative mode consensus mechanisms"]
4. (add more as discovered)

## Notes

- Last updated: YYYY-MM-DD
- Source: cowork-multi-agent-research skill
```

## Research Document Template

Save each research document as `research/YYYY-MM-DD-topic-slug.md`:

```markdown
# [Topic Title]

**Date:** YYYY-MM-DD  
**Topic:** [Brief topic description]

---

## 1. Findings

### Summary

[2–3 paragraph summary of what was researched]

### Papers / Frameworks / Case Studies

| Source       | Type                     | Key Points    |
| ------------ | ------------------------ | ------------- |
| [Title](URL) | Paper / Framework / Case | Bullet points |
| ...          | ...                      | ...           |

### Citations

- [Author, Year] — [Title](URL)
- ...

---

## 2. CoWork OS Applicability

- **Agent Teams**: [How does this apply to CoWork OS agent teams?]
- **Sub-agents / spawn_agent**: [Relevance to sub-agent spawning?]
- **Collaborative Mode**: [Implications for collaborative multi-agent thinking?]
- **Mention tools**: [How do mention tools relate?]
- **Other**: [Any other CoWork OS features]

---

## 3. Implementation Recommendations

1. [Concrete recommendation 1]
2. [Concrete recommendation 2]
3. [Concrete recommendation 3]

---

## 4. Next Topics (for Queue)

- [Topic discovered during research]
- [Another topic]
```

## Detailed Workflow

### Step 1: Read PROGRESS.md

- **Path**: `PROGRESS.md` at workspace root (or `research/PROGRESS.md` if project uses a research subfolder)
- **Action**: Read the file. If it does not exist, create it using the template above.
- **Check**: Scan "Completed Topics" — do not re-research any topic listed there.

### Step 2: Select Topic

- **If queue has items**: Use the first item in "Queue (Next Topics)".
- **If queue is empty**: Use a newly discovered topic from prior research, or ask the user for a topic.
- **If user specified a topic**: Use that topic instead of the queue.

### Step 3: Search

Use web search for:

- **Papers**: arXiv, ACL, NeurIPS, ICML, etc. — "multi-agent system" + year
- **Frameworks**: LangGraph, CrewAI, AutoGen, etc. — GitHub, docs, blog posts
- **Production case studies**: Company blogs, tech talks, deployment stories

Search terms examples:

- "multi-agent orchestration 2024 2025"
- "agent handoff context transfer"
- "hierarchical multi-agent"
- "collaborative AI agents production"
- "multi-LLM synthesis"

### Step 4: Write Research Document

- Follow the template above.
- **Findings**: Summarize sources with citations. Include URLs.
- **CoWork OS applicability**: Be specific. Reference CoWork OS features: agent teams, sub-agents, collaborative mode, mention tools, etc.
- **Implementation recommendations**: Actionable, ordered steps.

### Step 5: Save

- **Path**: `research/YYYY-MM-DD-topic-slug.md`
- **Slug**: Lowercase, hyphens (e.g., `hierarchical-agent-orchestration`)

### Step 6: Update PROGRESS.md

1. Add a row to "Completed Topics":
   - Date | Topic | File (e.g., `research/2025-03-18-hierarchical-agent-orchestration.md`)
2. Remove the completed topic from "Queue (Next Topics)".
3. Add any new topics discovered to the queue.
4. Update "Last updated" date.

## CoWork OS Context (for Applicability)

- **Agent Teams**: Persistent or ephemeral teams with shared checklists, coordinated runs, and team management UI.
- **Sub-agents**: `spawn_agent` with nesting; sub-agents can run in parallel.
- **Collaborative Mode**: Ephemeral multi-agent teams with real-time thought sharing; leader agent synthesizes the final result.
- **Multi-LLM** mode: Compare providers with a judge.
- **Mention tools**: Enable multi-agent collaboration and task delegation.
- **Orchestration**: `IntentRouter`, `TaskStrategyService`, `WorkflowDecomposer`, `WorkflowPipeline`.

## Search Tips

- Prefer recent papers (2024–2025) when available.
- Include production deployments (e.g., "how X deploys multi-agent").
- Note frameworks and their trade-offs (sequential vs parallel, handoff vs shared context).
- Check CoWork OS docs: `docs/competitive-landscape-research.md`, `docs/architecture.md`, `docs/features.md` for alignment.
