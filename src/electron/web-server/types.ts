/**
 * Web Access types — hosted mode for browser-based access.
 */

export interface WebAccessConfig {
  enabled: boolean;
  port: number;
  host: string;
  token: string;
  allowedOrigins: string[];
}

export const DEFAULT_WEB_ACCESS_CONFIG: WebAccessConfig = {
  enabled: false,
  port: 3847,
  host: "127.0.0.1",
  token: "",
  allowedOrigins: ["http://localhost:3847"],
};

export interface WebAccessRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  ipcChannel: string;
  extractParams?: (req: any) => any;
}

export interface WebAccessStatus {
  running: boolean;
  url?: string;
  port?: number;
  connectedClients: number;
  startedAt?: number;
}
