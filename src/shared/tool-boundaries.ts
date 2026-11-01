import { computerToolKind, type BotWorksOn } from "./bot-computer";

/**
 * What a tool can reach. Every built-in tool has one (a test fails when a new tool has none),
 * so the boundary of a run in a bot's own folder is decided per class and a tool nobody
 * classified is never given to such a run.
 * - app: CoWork's own state (tasks, plans, memory, agents, skills, persona, scheduling)
 * - workspace_files: files, through the workspace file boundary (evaluateWorkspaceFilesystemAccess)
 * - web: the internet, through CoWork's network policy (internal hosts blocked)
 * - integration: a connected account or service (mail, calendar, drives, channels, calls)
 * - host_shell: commands and code on this computer (sandboxed unless Full access)
 * - host_computer: this computer's apps, screen, clipboard and terminal tabs ("Works on")
 * - host_info: read-only facts about this computer (system, app paths, location)
 * - host_system: this computer's environment, processes and login items
 * - host_device: a phone connected to this computer
 * - local_web: a browser on this computer that may open its local servers (QA)
 * - browser: the in-app browser ("Works on")
 * - bot_desktop: the bot's own desktop container
 * - handoff: handing a step to the person
 * - connector: a tool of an MCP connector (decided at run time by its server)
 */
export type ToolBoundaryClass =
  | "app"
  | "workspace_files"
  | "web"
  | "integration"
  | "host_shell"
  | "host_computer"
  | "host_info"
  | "host_system"
  | "host_device"
  | "local_web"
  | "browser"
  | "bot_desktop"
  | "handoff"
  | "connector";

/**
 * Families named by prefix; checked after the computer tools and the exact names below. Only
 * families whose class already reaches this computer: a family a contained run may use is
 * listed by name, so a new member (say `set_clipboard`) stays unclassified until someone
 * chooses its class.
 */
const PREFIX_CLASSES: ReadonlyArray<readonly [string, ToolBoundaryClass]> = [
  ["android_phone_", "host_device"],
  ["git_", "host_shell"],
  ["local_photoshop_", "host_computer"],
  ["qa_", "local_web"],
];

const FAMILY_CLASSES: ReadonlyArray<readonly [ToolBoundaryClass, readonly string[]]> = [
  [
    "app",
    [
      "kg_add_observation",
      "kg_create_edge",
      "kg_create_entity",
      "kg_delete_edge",
      "kg_delete_entity",
      "kg_get_neighbors",
      "kg_get_subgraph",
      "kg_invalidate_edge",
      "kg_search",
      "kg_update_entity",
      "set_agent_name",
      "set_expertise",
      "set_persona",
      "set_personality",
      "set_quirks",
      "set_response_style",
      "set_user_name",
      "set_vibes",
      "skill_create",
      "skill_delete",
      "skill_duplicate",
      "skill_proposal",
      "skill_update",
      "task_list_create",
      "task_list_list",
      "task_list_update",
    ],
  ],
  [
    "workspace_files",
    [
      "canvas_add_asset",
      "canvas_checkpoint",
      "canvas_checkpoints",
      "canvas_close",
      "canvas_create",
      "canvas_eval",
      "canvas_export",
      "canvas_hide",
      "canvas_list",
      "canvas_open_url",
      "canvas_push",
      "canvas_restore",
      "canvas_show",
      "canvas_snapshot",
      "monty_list_transforms",
      "monty_run",
      "monty_run_transform",
      "monty_transform_file",
    ],
  ],
  [
    "web",
    [
      "scrape_extract",
      "scrape_multiple",
      "scrape_page",
      "scrape_session",
      "youtube_ask_or_ingest_video",
      "youtube_ask_video",
      "youtube_ingest_video",
      "youtube_list_ingested_videos",
      "youtube_search_ingested_segments",
    ],
  ],
];

const EXACT_CLASSES: Readonly<Record<string, ToolBoundaryClass>> = {
  computer_environment: "workspace_files",
  ...Object.fromEntries(
    FAMILY_CLASSES.flatMap(([boundary, names]) => names.map((name) => [name, boundary])),
  ),
  // CoWork's own state
  Skill: "app",
  acknowledge_mention: "app",
  add_behavioral_rule: "app",
  cancel_agent: "app",
  capture_agent_events: "app",
  complete_mention: "app",
  context_recall: "app",
  count_text: "app",
  create_issue: "app",
  extract_json: "app",
  get_agent_status: "app",
  get_orchestration_status: "app",
  get_pending_mentions: "app",
  integration_setup: "app",
  link_project_workspace: "app",
  list_agent_roles: "app",
  list_agents: "app",
  list_goals: "app",
  list_issues: "app",
  list_projects: "app",
  list_workspaces: "app",
  manage_connector_events: "app",
  manage_heartbeat: "app",
  meeting_artifact_get: "app",
  meeting_artifacts_list: "app",
  memory_forget: "app",
  memory_recall: "app",
  memory_remember: "app",
  mention_agent: "app",
  orchestrate_agents: "app",
  pause_agent: "app",
  // Suggested tasks: a card for the person; nothing runs until they start it.
  propose_task: "app",
  request_protected_credential: "app",
  request_user_input: "app",
  resume_agent: "app",
  revise_plan: "app",
  schedule_task: "app",
  scratchpad_read: "app",
  scratchpad_write: "app",
  send_agent_message: "app",
  spawn_agent: "app",
  switch_workspace: "app",
  task_events: "app",
  task_history: "app",
  text_metrics: "app",
  // Thread subscriptions are CoWork task state; delivered events arrive as follow-ups.
  thread_subscribe: "app",
  thread_unsubscribe: "app",
  tool_search: "app",
  update_lore: "app",
  visual_open_annotator: "app",
  visual_update_annotator: "app",
  wait: "app",
  wait_for_agent: "app",
  wait_for_event: "app",
  withdraw_task_proposal: "app",
  // Files, through the workspace file boundary
  analyze_image: "workspace_files",
  batch_image_process: "workspace_files",
  copy_file: "workspace_files",
  create_diagram: "workspace_files",
  create_directory: "workspace_files",
  create_document: "workspace_files",
  create_presentation: "workspace_files",
  create_spreadsheet: "workspace_files",
  delete_file: "workspace_files",
  edit_document: "workspace_files",
  edit_file: "workspace_files",
  edit_pdf_region: "workspace_files",
  generate_document: "workspace_files",
  generate_epub: "workspace_files",
  generate_landing_page: "workspace_files",
  generate_presentation: "workspace_files",
  generate_spreadsheet: "workspace_files",
  get_file_info: "workspace_files",
  glob: "workspace_files",
  grep: "workspace_files",
  list_directory: "workspace_files",
  list_directory_with_sizes: "workspace_files",
  organize_folder: "workspace_files",
  parse_document: "workspace_files",
  preview_web_page: "workspace_files",
  read_file: "workspace_files",
  read_files: "workspace_files",
  read_pdf_visual: "workspace_files",
  rename_file: "workspace_files",
  search_files: "workspace_files",
  write_file: "workspace_files",
  // The internet, through the network policy
  cancel_video_generation_job: "web",
  generate_image: "web",
  generate_narration_audio: "web",
  get_video_generation_job: "web",
  http_request: "web",
  scraping_status: "web",
  web_fetch: "web",
  web_search: "web",
  x_search: "web",
  // Connected accounts and services
  apple_calendar_action: "integration",
  apple_reminders_action: "integration",
  box_action: "integration",
  calendar_action: "integration",
  channel_download_discord_attachment: "integration",
  channel_fetch_discord_messages: "integration",
  channel_history: "integration",
  channel_list_chats: "integration",
  dropbox_action: "integration",
  email_imap_unread: "integration",
  gmail_action: "integration",
  google_drive_action: "integration",
  mailbox_action: "integration",
  notion_action: "integration",
  onedrive_action: "integration",
  pact_discover: "integration",
  pact_get_conversation: "integration",
  pact_send_message: "integration",
  sharepoint_action: "integration",
  voice_call: "integration",
  // Commands and code on this computer (LaTeX runs a compiler here)
  compile_latex: "host_shell",
  execute_code: "host_shell",
  process_output: "host_shell",
  run_command: "host_shell",
  stop_process: "host_shell",
  // Facts about this computer
  acp_discover: "host_info",
  get_app_paths: "host_info",
  get_current_location: "host_info",
  resolve_app_bundle_id: "host_info",
  system_info: "host_info",
  // This computer's environment, processes and login items
  disable_macos_launch_agents: "host_system",
  find_macos_app_processes: "host_system",
  get_env: "host_system",
  list_macos_launch_agents: "host_system",
  native_application_inspect: "host_system",
  terminate_macos_app_processes: "host_system",
};

/** The class of a tool, or undefined when nobody classified it. */
export function toolBoundaryClass(
  toolName: string,
  options: { mcpToolNamePrefix?: string } = {},
): ToolBoundaryClass | undefined {
  const prefix = options.mcpToolNamePrefix || "mcp_";
  if (toolName.startsWith(prefix)) return "connector";
  switch (computerToolKind(toolName)) {
    case "host":
      return "host_computer";
    case "browser":
      return "browser";
    case "desktop":
      return "bot_desktop";
    case "handoff":
      return "handoff";
  }
  if (Object.prototype.hasOwnProperty.call(EXACT_CLASSES, toolName)) {
    return EXACT_CLASSES[toolName];
  }
  return PREFIX_CLASSES.find(([family]) => toolName.startsWith(family))?.[1];
}

/**
 * Whether a run in a bot's own folder may use a tool of this class. Unclassified tools, this
 * computer's environment, processes, phone and local servers, and connectors that run as
 * programs on this computer (stdio) are refused. Host commands are refused for a bot with its
 * own desktop (they run there instead). "Works on" still decides the computer tools.
 */
export function isToolBoundaryAllowedForContainedRun(
  boundary: ToolBoundaryClass | undefined,
  context: { worksOn?: BotWorksOn; localConnector?: boolean },
): boolean {
  switch (boundary) {
    case undefined:
    case "host_system":
    case "host_device":
    case "local_web":
      return false;
    case "host_shell":
      return context.worksOn !== "own_desktop";
    case "connector":
      return context.localConnector !== true;
    default:
      return true;
  }
}
