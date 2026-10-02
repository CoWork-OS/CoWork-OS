import type { LLMModelInfo } from "../../shared/types";

/** "GPT-6 Astra for ChatGPT subscription access" reads as "ChatGPT subscription access". */
export function getModelDetail(model: Pick<LLMModelInfo, "displayName" | "description">): string {
  let detail = model.description?.trim() || "";
  if (detail.toLowerCase().startsWith(model.displayName.toLowerCase())) {
    detail = detail.slice(model.displayName.length).trim();
  }
  if (/^for\s+/i.test(detail)) {
    detail = detail.replace(/^for\s+/i, "");
    detail = detail.charAt(0).toUpperCase() + detail.slice(1);
  }
  return detail;
}
