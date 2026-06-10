# Architecture Design Skill

`architecture-design` is a bundled CoWork OS skill for orchestrating concept architecture workflows across local Rhino, Blender, and ComfyUI connectors.

It is designed for:

- house and building concept studies
- site-to-massing workflows
- floor plan and room-program iteration
- Rhino model export into Blender scenes
- Blender material, camera, lighting, and render passes
- ComfyUI photoreal image passes from approved renders

It is not a substitute for:

- licensed architectural, structural, MEP, accessibility, zoning, or code compliance review
- destructive edits to source CAD files without explicit user approval
- public or remote exposure of local Rhino, Blender, or ComfyUI services

## Required Local Connectors

The skill uses three bundled local MCP connectors:

| Connector | Purpose | Default local endpoint |
|-----------|---------|------------------------|
| Rhino | Site references, terrain, setbacks, massing, floor plans, validation, viewport capture, model export | `http://127.0.0.1:17641` |
| Blender | Scene import, materials, camera, lighting, viewport capture, render output, scene save | `http://127.0.0.1:17642` |
| ComfyUI | Workflow listing, workflow submission, Flux-style photoreal pass, job status, output collection | `http://127.0.0.1:8188` |

The Rhino and Blender connectors expect separate localhost bridge processes that expose JSON endpoints matching the connector tools. The ComfyUI connector calls a local ComfyUI API directly.

## Setup

Configure the architecture project root before using file-oriented tools:

```sh
COWORK_ARCH_PROJECT_ROOT=/absolute/path/to/project
RHINO_MCP_BRIDGE_URL=http://127.0.0.1:17641
BLENDER_MCP_BRIDGE_URL=http://127.0.0.1:17642
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_DIR=workflows
```

`COWORK_ARCH_PROJECT_ROOT` is required for project files, source image paths, workflow directories, copied ComfyUI outputs, Rhino exports, Blender scenes, and render outputs. If it is not set, file-path tools fail closed.

Only localhost bridge/API URLs are accepted. File and directory arguments are normalized under `COWORK_ARCH_PROJECT_ROOT` or `COWORK_WORKSPACE_ROOT`; URL-style paths and paths outside the project root are rejected before a bridge receives the request.

## Workflow

The skill follows this evidence-first sequence:

1. Create `.cowork/architecture-projects/<project-id>/`.
2. Write `brief.json` and `manifest.json`.
3. Check `rhino.health`, `blender.health`, and `comfyui.health`.
4. Use Rhino for site references, terrain/setbacks, massing, plans, validation, and model export.
5. Use Blender for model import, material assignment, camera/lighting setup, renders, and scene save.
6. Use ComfyUI for an optional Flux-style photoreal pass, job monitoring, and output collection.
7. Update `manifest.json` after each successful stage with tool results, file paths, warnings, and pending decisions.

## Artifact Layout

```text
.cowork/architecture-projects/<project-id>/
  brief.json
  manifest.json
  references/
  site/
  rhino/
  blender/
  comfyui/
  renders/
  exports/
  report.md
```

## Safety Model

- The skill must not claim Rhino, Blender, or ComfyUI completed work without a tool result or saved artifact.
- Generated files stay inside the architecture project root.
- Imported user assets should be copied into the project folder before mutation.
- Source CAD overwrites, deletions, and long or expensive render jobs require explicit approval.
- Outputs should be described as concept design until a qualified professional validates code, structure, accessibility, and MEP requirements.

## Example Prompts

```text
Use the architecture-design skill to create a concept workflow for a two-story courtyard house.

Create the project folder under .cowork/architecture-projects/courtyard-house.
Use Rhino for massing and plan iteration, Blender for one exterior render, and ComfyUI only if the local API is available.
Keep all artifacts in the project folder and stop before any long render.
```

```text
Use architecture-design to turn references/site-plan.png into a rough Rhino massing and Blender render.

Copy the reference into the project folder first.
Produce a manifest with each tool result and tell me which connector stages were unavailable.
```
