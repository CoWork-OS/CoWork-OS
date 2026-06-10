---
name: architecture-design
description: "Orchestrate an architectural concept workflow across Rhino, Blender, and ComfyUI connectors."
---

# Architecture Design

## Purpose

Orchestrate architectural concept design from brief and references through Rhino massing, Blender rendering, and ComfyUI photoreal output.

## Routing

- Use when: The user asks to design, model, render, or iterate an architectural concept, floor plan, house, building massing, site plan, facade, or photoreal architecture visualization.
- Do not use when: The user only wants a high-level written strategy, a building-code/legal opinion, or structural/MEP engineering certification.
- Outputs: Project manifest, Rhino model outputs, Blender scene/render outputs, ComfyUI images, decisions, warnings, and next-step checklist.
- Success criteria: The workflow uses connector evidence for every claimed app action, keeps artifacts in a workspace project folder, and asks for approval before destructive changes or long-running renders.

## Workflow

1. Create a workspace project folder under `.cowork/architecture-projects/<project-id>/` and use it as `COWORK_ARCH_PROJECT_ROOT`.
2. Write `brief.json` and `manifest.json` before calling design tools.
3. Check connector health in this order:
   - `mcp_rhino.health`
   - `mcp_blender.health`
   - `mcp_comfyui.health`
4. If Rhino is available, create/open the project, import site references, create terrain/setbacks, generate massing, generate floor plans, validate, then export to Blender format.
5. If Blender is available, import the Rhino export, assign materials by layer/object names, set camera and lighting, render one or more views, and save the scene.
6. If ComfyUI is available, submit the chosen render plus prompt context through the photoreal workflow, monitor status, and collect outputs.
7. Update `manifest.json` after every successful stage with file paths, tool results, warnings, and pending decisions.
8. Use computer-use tools only as a fallback for native UI actions that have no connector/tool path.

## Safety Rules

- Never claim Rhino, Blender, or ComfyUI completed a step without a tool result or saved artifact.
- Keep all generated files in the project folder; connector file arguments are rejected if they resolve outside `COWORK_ARCH_PROJECT_ROOT`.
- Copy imported user assets into the project folder before mutation.
- Ask for confirmation before overwriting source CAD files, deleting generated assets, or starting expensive/long renders.
- Treat the result as concept design unless a licensed professional validates code, structure, accessibility, and MEP requirements.

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

## Connector Notes

- Rhino connector expects `COWORK_ARCH_PROJECT_ROOT` and a localhost Rhino bridge configured by `RHINO_MCP_BRIDGE_URL`.
- Blender connector expects `COWORK_ARCH_PROJECT_ROOT` and a localhost Blender bridge configured by `BLENDER_MCP_BRIDGE_URL`.
- ComfyUI connector expects `COWORK_ARCH_PROJECT_ROOT` and uses `COMFYUI_BASE_URL`, defaulting to `http://127.0.0.1:8188`.
- If any connector is missing, provide setup steps and continue with the available stages only.
