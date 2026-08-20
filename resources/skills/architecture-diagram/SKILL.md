---
name: architecture-diagram
description: "Generate polished dark-themed architecture diagrams as standalone HTML files with inline SVG, semantic system grouping, and readable connection flows."
version: "1.0.0"
license: MIT
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
  source-author: "Cocoon AI, ported by CoWork OS"
---

# Architecture Diagram

## Purpose

Turn an architecture description or inspected codebase into a self-contained HTML diagram with inline SVG that opens directly in any modern browser.

## Routing

- Use when: Use when the user asks to create a technical architecture diagram, infrastructure map, deployment topology, security/data-flow visual, or a polished system diagram artifact they can open in a browser.
- Do not use when: Do not use for text-only summaries, requests that require Mermaid or another explicit diagram format, or non-technical visual design tasks such as UI mockups and marketing graphics.
- Outputs: A standalone HTML architecture diagram plus supporting plan and summary artifacts.
- Success criteria: The final HTML is readable, self-contained, faithful to the described or inspected system, and free of obvious layout collisions.

## Trigger Examples

### Positive

- Create an architecture diagram for this SaaS stack and give me an HTML file.
- Turn this codebase into a polished cloud architecture diagram.
- Make a system topology diagram showing services, databases, queues, and auth.
- Use the architecture-diagram skill for this request.

### Negative

- Summarize this architecture in bullets only.
- Draw this as Mermaid so I can paste it into Markdown.
- Design a landing page hero illustration for our product.
- Create a wireframe for the settings screen.

## Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| system_name | string | No | Short system or project name for the header |
| diagram_brief | string | No | Structured architecture description |
| diagram_type | select | No | Diagram emphasis: auto, system-overview, cloud-infrastructure, deployment, data-flow, security, network-topology, microservices |
| output_path | string | No | Workspace-relative or absolute HTML output path |

## Workflow Notes

- Start from `assets/template.html`. Do not freehand the outer page shell unless the request explicitly needs a very different composition.
- Read `references/full-guidance.md` before major layout work. It contains the spacing, legend placement, component taxonomy, and arrow-order rules that keep the diagrams readable.
- If the request is based on a local codebase, inspect the code first and derive components conservatively. Missing certainty is better than invented systems.
- Prefer a slightly taller or wider SVG over cramped placement. Expanding the `viewBox` is cheap; unreadable overlaps are not.
- When updating an existing diagram, preserve the established visual language unless the user asks for a redesign.
- In the final assistant response, include a standalone `::html{...}` directive that points at the generated HTML file so the main conversation view can render the diagram inline.

## Reference Map

- `references/full-guidance.md`: design system, layout heuristics, and output checklist
- `assets/template.html`: starter HTML/SVG template to customize
- `LICENSE.txt`: upstream MIT license carried with the bundled port

## Runtime Prompt

- Runtime prompt is defined directly in `../architecture-diagram.json`.
