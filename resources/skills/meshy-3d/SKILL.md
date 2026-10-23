---
name: meshy-3d
description: "Create 3D models with Meshy AI from text or images, then texture, remesh, rig, animate, convert or prepare them for 3D printing, and show them as interactive 3D cards in chat."
version: "1.0.0"
metadata:
  author: CoWork OS Contributors <info@coworkosapp.com>
  source: https://github.com/meshy-dev/meshy-mcp-server
---

# Meshy 3D

Make and edit 3D assets on Meshy's cloud through the Meshy connector (Meshy's own MCP server): text or image to 3D, texturing, remeshing, rigging, animation, format conversion, real-world resizing, UV unwrapping, concept images, printability checks and repair, multicolor 3MF and splitting into printable parts. Most calls spend the user's Meshy credits.

## Setup

- The tools are `mcp_meshy_*` (for example `mcp_meshy_text_to_3d`). When they are not in your tool list, find them with `tool_search` ("meshy text to 3d", "meshy download"). Never guess a name.
- No Meshy tools at all: the connector is not installed. Tell the user to add Meshy in Settings → Connectors and paste their API key there (meshy.ai → Settings → API; Pro plan or above). Never ask for the key in chat and never run Meshy's own `npx add-mcp` setup.
- A 401 or "invalid key" error means the key in Settings → Connectors → Meshy is missing or wrong.

## Credits and approvals

- Before every call that spends credits, say which tool, which model option and what it costs (text-to-3D preview 5-25, refine 10-15, image-to-3D 5-40, text-to-image 3-9, retexture 10-15, remesh 5, rig 5, animate 3 per action, convert 1, resize 1, multicolor/repair/split 10, Creative Lab 6-62), and wait for the user's yes. Offer `mcp_meshy_check_balance` (free) for a big job.
- CoWork's approval card is the second gate: it names the estimated cost and what this task has spent on Meshy, and asks again past the task's 200-credit limit. If the user declines, stop; do not retry or look for another way.
- Read-only calls (balance, task status, task and model lists, animation library, slicer detection, printability analysis) are free and run without a prompt.
- A message from a 3D card's Next menu ("Meshy task <id>: ... This message is my confirmation of the N-credit cost") already confirms that cost; still ask for any choice it says to ask about.

## Procedure

1. Pick the route before the first paid call, because `target_formats` is fixed at creation:
   - From text: `meshy_text_to_3d` (untextured preview) → `meshy_text_to_3d_refine` (textures) → download.
   - From a photo: `meshy_image_to_3d` with an absolute `file_path` (textured in one task) → download.
   - Concept first: `meshy_text_to_image` → user picks → `meshy_image_to_3d` with `input_task_id`.
   - Rigged, animated character: generate textured with `pose_mode: "t-pose"` → `meshy_rig` → `meshy_list_animations` → `meshy_animate`.
   - 3D print: `meshy_send_to_slicer` (detect, free) → generate → `meshy_analyze_printability` (free) → download with `print_ready: true`, or `meshy_process_multicolor` for a multicolor 3MF.
2. Pick the detail level unless the user said: ask what the asset is and where it goes, not for a triangle number. Game assets use Smart Topology (`model_type: "smart-topology"`) at about 15k triangles for a hero character, 5-15k for an NPC, 3k for a weapon, 1.5k for a small prop (mobile about half). Renders, close-ups and prints use full detail. Polycount does not change the price.
3. Submit once. Every create returns a `task_id`; keep it. If a create times out or fails with a network or 5xx error, the task may exist and be billed: check `meshy_list_tasks` before creating again.
4. Don't wait when nothing needs the result yet. Right after a create, end your reply with the card line on its own:
   `::model{task="<task_id>" title="<short name>"}`
   The card shows Meshy's progress, then the model with Download and Next menus. Wait with `meshy_get_task_status` (it waits up to 5 minutes per call; poll again if it times out) only when the next step needs the finished task.
5. Download with `meshy_download_model`, one `format` per call, the one the use case needs. Always pass `save_to` as an ABSOLUTE path inside the workspace (for example `<workspace>/models/treasure-chest.glb`) unless the user named another folder. Report each saved path and its size.
6. Show the model: after a GLB download, end the reply with one line per model:
   `::model{path="<absolute path of the .glb>" task="<task_id>"}`
   The card is an interactive viewer (orbit, wireframe, animation clips) whose Download menu saves any other format Meshy made for that task, free. Write the path in prose too.
7. Report what the file holds: format, credits spent, the actual triangle count (not the target) and the task id for follow-ups (refine, rig and convert reuse it instead of regenerating). Say "rigged" or "animated" only when the viewer or the file shows a skeleton or clips.

## Formats

| Use | Format |
|---|---|
| Godot, web, three.js, sharing a viewable file | GLB |
| Unity, Unreal, Maya, 3ds Max, C4D | FBX (OBJ for a static mesh) |
| Apple AR (Quick Look, Vision Pro) | USDZ |
| Single-colour 3D print | STL, or OBJ with `print_ready: true` |
| Multicolour 3D print | 3MF via `meshy_process_multicolor` |

A finished task already holds signed links to all its formats (`model_urls` in the structured result of `meshy_get_task_status`); downloading one is free. If a format is missing, `meshy_convert` costs 1 credit. Links expire 3 days after the task finished; saved files are permanent. Never call a download "game-ready": it has no LODs or collision mesh, and scale or pivot may need fixing.

## Channels and other surfaces

In a Slack, Telegram, Discord or other channel conversation the `::model` line shows as text: give the thumbnail link, the saved path and the next steps as a short numbered list with their credit costs instead (for example: 1. Texture it · 10 cr 2. Remesh · 5 cr 3. Check printability · free).

## Pitfalls

- A text-to-3D preview has no textures: refine it, or use the image route.
- Rigging needs a textured humanoid at 300k faces or fewer; remesh first if denser.
- Animation `action_id`s come from `meshy_list_animations`; never invent one. Use the in-place variants (`search: "inplace"`) when the game moves the character.
- UV unwrap needs a GLB with 40k faces or fewer.
- `meshy_cancel_task` on a finished task DELETES it; confirm with the user first.
- `meshy_list_tasks` without `task_types` covers only the generation types.
- Local inputs (`file_path`, `file_paths`) must be absolute paths; never base64-encode an image yourself.
- `meshy_send_to_slicer` returns a launch command; run it only after the user picks the slicer.
