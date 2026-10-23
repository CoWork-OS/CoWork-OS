# 3D Models with Meshy

Ask CoWork for a 3D model and it makes one with [Meshy](https://www.meshy.ai), then shows it in
the chat as an interactive 3D card you can orbit, zoom and animate. "Make a low-poly treasure
chest for my Godot game", "turn ~/photos/mug.jpg into a model I can print at 10 cm" or "rig
this knight and make it wave" all work the same way: CoWork names the credit cost, waits for
your yes, starts the Meshy job, and the card tracks it until the model is ready.

CoWork runs Meshy's own MCP server, pinned to a reviewed version, and adds the parts around
it: a cost line on every approval card, a per-task spend limit, the 3D viewer, a gallery of
everything you made, and a bundled `meshy-3d` skill that carries Meshy's workflow rules.

## What you can do

- **Text or image to 3D**: a model from a prompt, from one photo, or from up to four views of
  the same object.
- **Finish it**: texture a preview, retexture, remesh to a triangle budget, resize to
  real-world units, unwrap UVs, convert between formats.
- **Characters**: auto-rig a humanoid (walking and running clips included), add animations
  from Meshy's library, or generate a motion clip from text.
- **3D printing**: check printability, repair a mesh, make a multicolor 3MF for your slicer,
  split a model into printable parts, and hand it to an installed slicer.
- **Concept images**: draw a design first, approve it, then turn it into a model.
- **Look at any glTF model**: the same 3D card shows any `.glb` or self-contained `.gltf` in
  your workspace, made with Meshy or not.

## Set up

1. Open **Settings → Connectors**, find **Meshy** and click **Install**.
2. Paste your Meshy API key (`msy_…`, from meshy.ai → Settings → API; Meshy API keys need a
   Pro plan or above) and save.
3. Ask for a model. Node.js 18 or newer with `npx` must be on your PATH. On first use, the
   pinned `@meshy-ai/meshy-mcp-server` package is downloaded into npm's cache.

The key is stored with the rest of your connector settings, encrypted with the system
keychain. It is passed only to the Meshy server process and used by CoWork only for requests
to `api.meshy.ai`. Never paste it into the chat.

## Making a model

A typical request goes like this:

1. **Cost first.** The agent picks the route (text, image, concept image first, rig and
   animate, print) and the detail level for what the asset is for, then tells you which tool
   it will call and what it costs. For example: "Smart Topology at 1,500 triangles for a game
   prop, 5 credits for the untextured preview".
2. **Approval card.** Every call that can spend credits asks first. The card leads with the
   estimate and what this task has spent on Meshy so far, then shows the exact arguments.
3. **Progress card.** Right after the job starts, the reply shows a card with Meshy's progress
   ("Meshy is texturing", 38%) over the task's thumbnail, so the agent doesn't have to wait.
4. **Model card.** When the job finishes, the card turns into the 3D view. Models the agent
   saves into your project also appear as created files in the step that saved them.

Example prompts:

```
Make a low-poly treasure chest for my Godot game. Keep it under 2,000 triangles.
```

```
Turn ~/photos/mug.jpg into a 3D model I can print at 10 cm tall, and check it for printing.
```

```
Make a stylised knight character, rig it, and add a wave and a walk animation. Save the GLB in models/.
```

## The 3D card

The model fills a rounded frame on a studio backdrop. The title and the model's stats
(triangles, size and animation count) sit in the top-left corner.

- **Orbit and zoom** by dragging and scrolling on the model.
- **Toolbar** (appears on hover): animation clips as chips, play and pause, auto-rotate,
  wireframe, grid and reset view.
- **Next**: what you can do with this Meshy task next, with each step's credit cost (texture
  it, remesh, retexture, rig, animate, resize, check printability). Picking one sends a chat
  message that names the tool and the cost, after a confirmation dialog. The agent then makes
  the call, and its approval card still asks.
- **Download**: every file type Meshy already made for the task (GLB, FBX, OBJ with its
  material file, STL, USDZ, animation clips). Saving one costs no credits; it goes next to the
  model and opens in Finder. A tick marks formats already saved.
- **Open**: opens the model in the 3D gallery.

A reply can hold several cards. At most four hold a live 3D view at once, chosen by what's on
screen and what you used last. The others show a **View in 3D** poster until you scroll back
to them.

The agent writes the card as a line of its own in the reply:

```
::model{path="/Users/you/Projects/game/models/treasure-chest.glb" task="0199a1b2-…" title="Treasure chest"}
```

`path` is a `.glb` or `.gltf` file (absolute, or relative to the workspace). `task` is a Meshy
task id. With only a `task`, the card shows the job's progress and downloads the model (free)
into Meshy's folder when you first open it. `title` is optional. In Slack, Telegram, Discord
and other channels, and in the CLI, the line becomes plain text with the model's name and path.

## The 3D gallery

Click **Open** on a card to see everything in one place. The sidebar shows:

- your Meshy credit balance;
- **Recent from Meshy**: your latest generations, with thumbnails and the credits each cost;
- **On this machine**: models Meshy saved, in your projects or in its own folder;
- a search box that filters by prompt.

The selected model fills the rest of the window, with **Copy prompt**, **Copy task ID**,
**Show in Finder**, **Download** and **Next** above it. Picking a recent generation that isn't
on this machine yet downloads its GLB first (free), so it stays viewable after Meshy's links
expire.

## Credits and the spend limit

Meshy bills in credits. CoWork knows each tool's published price and puts it on the approval
card:

| Tool                                                  | Credits      |
| ----------------------------------------------------- | ------------ |
| Text to 3D preview                                    | 5–25         |
| Texture a preview (refine), retexture                 | 10–15        |
| Image to 3D, multi-image to 3D                        | 5–40         |
| Concept image, image edit                             | 3–12         |
| Rig                                                   | 5            |
| Animate                                               | 3 per action |
| Text to motion                                        | 3–10         |
| Remesh, UV unwrap                                     | 5            |
| Convert, resize                                       | 1            |
| Multicolor 3MF, printability repair, split into parts | 10           |
| Creative Lab                                          | 6–62         |

Balance, task status, lists, the animation library, downloads, slicer detection and the
printability check are free. They run without asking.

- **Per-task limit:** each task may spend up to 200 credits on Meshy. A call that would take it
  past the limit asks again, even when you chose **Always allow** for that tool. The tally
  counts the top of each tool's range for every call that ran, not Meshy's actual bill.
- **New tools ask:** a Meshy tool with no listed price (one a later server version adds)
  always asks.
- **Unattended runs can't spend:** scheduled tasks and other runs without anyone to approve
  are refused instead.

## Where files go

- The agent saves downloads into your project (for example `models/treasure-chest.glb`) unless
  you name another folder.
- Without a folder, Meshy saves into its own folder: `mcp-data/meshy/meshy_output/` in
  CoWork's data folder (on macOS, `~/Library/Application Support/cowork-os/`).
- CoWork keeps a small index of the models Meshy saved, under `meshy/` in the same data folder.
  It holds paths, sizes, task ids and prompts only, never URLs or keys.
- Meshy's download links expire 3 days after a task finishes. Saved files are permanent.

## Privacy and security

- Prompts, and the images or models you point it at, go to Meshy's API under your key. The
  Meshy server sends no analytics of its own.
- The 3D viewer reads only `.glb` and `.gltf` files, and only inside a workspace CoWork knows
  or files Meshy saved. A model path the agent writes cannot make the app read other files.
- CoWork fetches thumbnails and downloads only from `https://assets.meshy.ai` and refuses
  redirects. A download never overwrites an existing file.
- Only a path the agent asked Meshy to save to, or one inside the workspace or Meshy's folder,
  is recorded as a model. Anything else the server reports is ignored.

## Limits

- Models compressed with Draco or meshopt, or using Basis textures, can't be shown in the
  viewer; Meshy's own models don't use them. A `.gltf` that loads separate `.bin` or texture
  files can't be shown either; open the `.glb` instead.
- The spend tally is kept in memory, so it starts over when CoWork restarts. Routines that call
  an MCP tool directly, and outside clients using CoWork's MCP host, are not counted.
- Replies in chat channels show the model as a line of text. CoWork doesn't render a preview
  video for channels.

## Troubleshooting

| Symptom                                                           | Fix                                                                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "Add your Meshy API key in Settings → Connectors → Meshy."        | Paste the key in the connector's settings and save.                                                       |
| "Meshy rejected the API key"                                      | The key is mistyped, revoked, or on a plan without API access.                                            |
| The Meshy tools don't appear                                      | Check that Node.js 18+ and `npx` are on your PATH, then reconnect the connector in Settings → Connectors. |
| "This Meshy download link has expired"                            | The task finished more than 3 days ago. Use a saved copy, or ask the agent to make it again.              |
| A model shows "That model is not one Meshy saved on this machine" | Open it from your workspace or the gallery; the viewer refuses files outside those places.                |

## Verification

- Connector install defaults (pinned package, own folder, approval mode, timeout):
  `src/electron/mcp/__tests__/MCPRegistryManager.test.ts`.
- Costs, the spend limit and the approval card's cost line:
  `src/electron/mcp/__tests__/tool-costs.test.ts`,
  `src/electron/agent/tools/__tests__/mcp-approval-preview.test.ts`.
- Meshy API mapping, the model index, downloads and result handling:
  `src/electron/meshy/__tests__/`.
- File access for the viewer and the Download menu:
  `src/electron/ipc/__tests__/meshy-handlers.test.ts`.
- The `::model` line, its plain-text form and glTF checks:
  `src/renderer/components/__tests__/assistant-message-content.test.ts`,
  `src/shared/__tests__/rich-embeds.test.ts`,
  `src/renderer/components/Model3D/__tests__/model-stage.test.ts`.
- Checked live in the desktop app (PRs #763 and #764):
  - the real Meshy server installs and connects with 28 tools;
  - the approval card names the cost and the limit;
  - cards render a rigged, animated model and a textured one;
  - the toolbar, menus and gallery work in both themes.

  That check ran without a Meshy key, so a real generation was not part of it.

See also: [Features](features.md#3d-models-meshy), [Connector Inventory](connector-inventory.md),
[Enterprise Connectors](enterprise-connectors.md).
