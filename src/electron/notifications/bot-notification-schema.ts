/**
 * Bot notification tables, apart from the store so schema initialization (and its
 * bootstrap worker) can create them without loading zod and the notification options.
 */
export const BOT_NOTIFICATION_SCHEMA = `
 CREATE TABLE IF NOT EXISTS bot_notification_routes(workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,version INTEGER NOT NULL,options_json TEXT NOT NULL,activated_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(workspace_id,agent_role_id));
 CREATE TABLE IF NOT EXISTS bot_notification_route_requests(request_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,request_json TEXT NOT NULL,response_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_notification_intents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,agent_role_id TEXT NOT NULL,task_id TEXT NOT NULL,kind TEXT NOT NULL,source_key TEXT NOT NULL,route_version INTEGER NOT NULL,destination TEXT NOT NULL,due_at INTEGER NOT NULL,created_at INTEGER NOT NULL,state TEXT NOT NULL,notification_id TEXT,desktop TEXT NOT NULL DEFAULT 'not_requested',reason TEXT,UNIQUE(workspace_id,agent_role_id,source_key));
 CREATE INDEX IF NOT EXISTS idx_bot_notification_due ON bot_notification_intents(state,due_at);
 CREATE TABLE IF NOT EXISTS bot_notification_retry_requests(request_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,response_json TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS bot_notification_observations(task_id TEXT PRIMARY KEY,signature TEXT NOT NULL);
`;
