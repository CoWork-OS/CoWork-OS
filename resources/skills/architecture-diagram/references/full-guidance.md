# Architecture Diagram Guidance

Use this reference when generating or updating a standalone HTML architecture diagram from `assets/template.html`.

## Output Shape

Always produce a single `.html` file with:

- embedded CSS
- inline SVG
- no JavaScript requirement
- no external image assets
- only optional font loading from Google Fonts

The result should open directly in a browser and still look correct when shared as a single file.

## Page Structure

Use this structure unless the user asks for a different presentation:

1. Header
2. Main diagram container with SVG
3. Three summary cards below the diagram
4. Minimal footer metadata

The summary cards should explain the architecture in human terms, for example:

- entry points and clients
- core services and execution model
- data, security, or operational boundaries

## Design System

### Background

- Page background: `#020617`
- Diagram card background: translucent slate
- Use a subtle grid pattern in the SVG background

### Typography

Use JetBrains Mono for the technical visual language:

```html
<link
  href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap"
  rel="stylesheet"
/>
```

Typical sizes:

- 12px: main component labels
- 9px: sublabels
- 8px: annotations
- 7px: tiny legend or bus labels

### Component Colors

Use semantic coloring consistently.

| Type        | Fill                      | Stroke    | Use for                        |
| ----------- | ------------------------- | --------- | ------------------------------ |
| Frontend    | `rgba(8, 51, 68, 0.4)`    | `#22d3ee` | clients, UI, edge apps         |
| Backend     | `rgba(6, 78, 59, 0.4)`    | `#34d399` | APIs, services, workers        |
| Database    | `rgba(76, 29, 149, 0.4)`  | `#a78bfa` | databases, storage, AI/ML      |
| Cloud       | `rgba(120, 53, 15, 0.3)`  | `#fbbf24` | cloud infra, gateways, CDN     |
| Security    | `rgba(136, 19, 55, 0.4)`  | `#fb7185` | auth, secrets, guardrails      |
| Message Bus | `rgba(251, 146, 60, 0.3)` | `#fb923c` | queues, streams, buses         |
| External    | `rgba(30, 41, 59, 0.5)`   | `#94a3b8` | third-party or generic systems |

## SVG Rules

### Component Boxes

- Rounded rectangles, typically `rx="6"` or `rx="8"`
- `stroke-width="1.5"` for primary components
- Main label centered, bold, white
- Secondary label centered, muted slate

### Boundaries

Use larger dashed boundary boxes for:

- cloud regions
- clusters
- private networks
- trust zones
- security groups

Guidelines:

- region boundary: amber, `stroke-dasharray="8,4"`, `rx="12"`
- security group: rose, `stroke-dasharray="4,4"`, transparent fill

### Arrows

Define arrowheads with SVG markers. Draw arrows early in the SVG so boxes render on top of them.

Why this matters:

- arrows rendered after boxes visually clutter the diagram
- semi-transparent component fills otherwise let arrows show through

If you need to fully mask arrows behind a component, draw an opaque slate rectangle first, then the styled semi-transparent rectangle on top.

### Auth and Security Flows

- Prefer dashed rose strokes for auth or security flows
- Use compact labels such as `JWT`, `mTLS`, `PKCE`, `IAM`, or `TLS`

### Message Buses

Represent queues or event streams as narrow connector bars in the gaps between services, not as overlapping blocks.

## Layout Heuristics

### Spacing

Default box heights:

- 50 to 60px: standard service
- 80 to 120px: larger grouped service or multi-line cloud component

Keep a minimum vertical gap of 40px between stacked components.

Bad:

- a queue or connector overlapping the next component
- labels pushed into neighboring boxes

Good:

- connector centered inside the gap
- arrow labels offset away from strokes

### Legend Placement

Place legends outside the lowest boundary box.

Process:

1. Find the lowest boundary edge in the SVG.
2. Start the legend at least 20px below that edge.
3. Expand the `viewBox` height if needed.

Do not place the legend inside a region or cluster box just to save space.

### Scale and ViewBox

Increase the `viewBox` dimensions when the system is dense.

Prefer:

- wider canvases for multi-column distributed systems
- taller canvases for layered or channel-to-core architectures

Do not compress a large system into the default template dimensions if it makes labels unreadable.

## Diagram Planning

Before editing the template, reduce the system into:

1. entry points and clients
2. core compute or service layer
3. persistence layer
4. external dependencies
5. boundaries or trust zones
6. critical flows worth labeling

If the source is a codebase, inspect for:

- frontend apps
- APIs and workers
- databases and caches
- queues or streams
- authentication providers
- third-party integrations
- deployment or runtime targets

Call out any inferred assumptions in the summary artifact instead of silently inventing details.

## Summary Card Guidance

Use the three cards to make the diagram useful to a human reader without parsing every box.

Strong card themes:

- clients and ingress
- core services and execution
- data, security, and infrastructure

Keep each card concise, usually 3 to 5 bullets.

## Output Checklist

Before finishing, verify:

- title and subtitle are specific to the system
- viewBox fits the actual layout
- no major overlaps between boxes, arrows, or legends
- arrows communicate the primary flows
- summary cards match the actual diagram
- footer metadata is updated
- the file opens directly in a browser

## Adapting the Template

The template is intentionally opinionated. Treat it as a scaffold:

- keep the visual language
- replace example components with the real architecture
- resize or reposition aggressively when needed
- preserve consistency across component types and labels

When the architecture is extremely large, simplify the first diagram into the highest-signal overview rather than forcing every internal detail into a single image.
