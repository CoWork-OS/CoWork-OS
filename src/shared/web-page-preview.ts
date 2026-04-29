export type WebPagePreview = {
  format: "html";
  previewMode: "sandboxed_iframe";
  title?: string;
  htmlContent?: string;
  sourcePath: string;
  baseDir: string;
  projectRoot?: string;
  framework?: "react" | "vite" | "next" | "html";
  canPreview: boolean;
  previewMessage?: string;
};
