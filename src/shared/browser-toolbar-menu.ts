export const BROWSER_TOOLBAR_MENU_POPUP = "browserWorkbench:toolbarMenu";

export type BrowserToolbarMenuAction =
  | "annotate"
  | "screenshot"
  | "external"
  | "fit"
  | "outlines"
  | "diagnostics"
  | "appearance:app"
  | "appearance:light"
  | "appearance:dark"
  | `viewport:${number}`;

export type BrowserToolbarMenuRequest = {
  x: number;
  y: number;
  hasPage: boolean;
  viewports: { label: string; width: number; height: number }[];
  activeViewport: string | null;
  snapshotOverlay: boolean;
  diagnosticsOpen: boolean;
  /** Optional appearance controls; omitted by clients without browser theme settings. */
  colorScheme?: "light" | "dark" | null;
};
