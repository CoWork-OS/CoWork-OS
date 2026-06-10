# ComfyUI MCP Connector

Local MCP connector for ComfyUI.

The connector defaults to `http://127.0.0.1:8188`. Override with:

```sh
COWORK_ARCH_PROJECT_ROOT=/path/to/project
COMFYUI_BASE_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW_DIR=workflows
COMFYUI_MCP_TIMEOUT_MS=60000
```

Only localhost base URLs are accepted.

Workflow directories, source image paths, and copied output directories must
resolve inside `COWORK_ARCH_PROJECT_ROOT` or `COWORK_WORKSPACE_ROOT`. The
`comfyui.submit_flux_photoreal_pass` tool applies `{{prompt}}`,
`{{negativePrompt}}`, `{{sourceImagePath}}`, and `{{projectId}}` placeholders
before submission so project metadata is reflected in the queued workflow.
