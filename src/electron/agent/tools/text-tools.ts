import type { Workspace } from "../../../shared/types";
import type { AgentDaemon } from "../daemon";
import type { LLMTool } from "../llm/types";
import { FileTools } from "./file-tools";

type CountMode =
  | "characters"
  | "characters_no_whitespace"
  | "words"
  | "lines"
  | "paragraphs"
  | "sentences";

type TextInputBase = {
  text?: string;
  path?: string;
  normalize_newlines?: boolean;
  trim?: boolean;
  collapse_whitespace?: boolean;
};

type CountTextInput = TextInputBase & {
  mode?: CountMode;
};

type TextMetricsInput = TextInputBase & {
  include_top_characters?: boolean;
  top_character_limit?: number;
};

type TextCounts = {
  characters: number;
  characters_no_whitespace: number;
  words: number;
  lines: number;
  paragraphs: number;
  sentences: number;
};

type CountTextResult =
  | {
      success: true;
      mode: CountMode;
      count: number;
      source: "text" | "file";
      path?: string;
      counts: TextCounts;
      empty: boolean;
    }
  | {
      success: false;
      error: string;
    };

type TextMetricsResult =
  | {
      success: true;
      source: "text" | "file";
      path?: string;
      counts: TextCounts;
      empty: boolean;
      top_characters?: Array<{
        character: string;
        count: number;
      }>;
    }
  | {
      success: false;
      error: string;
    };

export class TextTools {
  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
    private fileTools: FileTools,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "count_text",
        description:
          "Count text length and basic units exactly (characters, words, lines, paragraphs, sentences). " +
          "Prefer this over monty_run for character-count validation tasks.",
        input_schema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to count. Provide either text OR path.",
            },
            path: {
              type: "string",
              description:
                "Workspace-relative text file path to count. Provide either path OR text. " +
                "For DOCX/PDF, first extract content with read_file.",
            },
            mode: {
              type: "string",
              enum: [
                "characters",
                "characters_no_whitespace",
                "words",
                "lines",
                "paragraphs",
                "sentences",
              ],
              description: "What to count. Default: characters.",
            },
            normalize_newlines: {
              type: "boolean",
              description: "If true, normalize CRLF/CR to LF before counting.",
            },
            trim: {
              type: "boolean",
              description: "If true, trim leading/trailing whitespace before counting.",
            },
            collapse_whitespace: {
              type: "boolean",
              description:
                "If true, collapse all whitespace runs to single spaces before counting.",
            },
          },
        },
      },
      {
        name: "text_metrics",
        description:
          "Compute comprehensive text metrics (characters, words, lines, paragraphs, sentences). " +
          "Use for exact document-length checks and validation workflows.",
        input_schema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to analyze. Provide either text OR path.",
            },
            path: {
              type: "string",
              description:
                "Workspace-relative text file path to analyze. Provide either path OR text.",
            },
            normalize_newlines: {
              type: "boolean",
              description: "If true, normalize CRLF/CR to LF before analysis.",
            },
            trim: {
              type: "boolean",
              description: "If true, trim leading/trailing whitespace before analysis.",
            },
            collapse_whitespace: {
              type: "boolean",
              description:
                "If true, collapse all whitespace runs to single spaces before analysis.",
            },
            include_top_characters: {
              type: "boolean",
              description:
                "If true, include top character frequencies (with escaped whitespace labels).",
            },
            top_character_limit: {
              type: "number",
              description: "Maximum top characters to return (default: 10, max: 100).",
            },
          },
        },
      },
    ];
  }

  async countText(input: CountTextInput): Promise<CountTextResult> {
    try {
      const { text, source, path } = await this.resolveTextInput(input);
      const counts = this.computeCounts(text);
      const mode = (input?.mode || "characters") as CountMode;
      const countMap: Record<CountMode, number> = {
        characters: counts.characters,
        characters_no_whitespace: counts.characters_no_whitespace,
        words: counts.words,
        lines: counts.lines,
        paragraphs: counts.paragraphs,
        sentences: counts.sentences,
      };
      const count = countMap[mode] ?? counts.characters;

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "count_text",
        success: true,
        mode,
        count,
        source,
      });

      return {
        success: true,
        mode,
        count,
        source,
        path,
        counts,
        empty: text.length === 0,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "count_text",
        success: false,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  async textMetrics(input: TextMetricsInput): Promise<TextMetricsResult> {
    try {
      const { text, source, path } = await this.resolveTextInput(input);
      const counts = this.computeCounts(text);
      const includeTopCharacters = input?.include_top_characters === true;
      const topLimit = Math.max(
        1,
        Math.min(
          100,
          Number.isFinite(input?.top_character_limit) ? Number(input.top_character_limit) : 10,
        ),
      );

      const result: TextMetricsResult = {
        success: true,
        source,
        path,
        counts,
        empty: text.length === 0,
      };

      if (includeTopCharacters) {
        result.top_characters = this.buildTopCharacters(text, topLimit);
      }

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "text_metrics",
        success: true,
        source,
        characters: counts.characters,
        words: counts.words,
      });

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "text_metrics",
        success: false,
        error: message,
      });
      return { success: false, error: message };
    }
  }

  private async resolveTextInput(
    input: TextInputBase,
  ): Promise<{ text: string; source: "text" | "file"; path?: string }> {
    const fromText = typeof input?.text === "string";
    const fromPath = typeof input?.path === "string" && input.path.trim().length > 0;

    if (fromText && fromPath) {
      throw new Error("Provide either 'text' or 'path', not both");
    }
    if (!fromText && !fromPath) {
      throw new Error("count_text/text_metrics require either 'text' or 'path'");
    }

    if (fromText) {
      const preprocessed = this.preprocessText(String(input.text), input);
      return { text: preprocessed, source: "text" };
    }

    const filePath = String(input.path).trim();
    const raw = await this.fileTools.readTextFileRaw(filePath, { maxBytes: 2_000_000 });
    const preprocessed = this.preprocessText(raw.content, input);
    return {
      text: preprocessed,
      source: "file",
      path: filePath,
    };
  }

  private preprocessText(text: string, input: TextInputBase): string {
    let normalized = text;
    if (input?.normalize_newlines) {
      normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }
    if (input?.trim) {
      normalized = normalized.trim();
    }
    if (input?.collapse_whitespace) {
      normalized = normalized.replace(/\s+/g, " ").trim();
    }
    return normalized;
  }

  private computeCounts(text: string): TextCounts {
    const words = text.match(/\S+/g)?.length || 0;
    const lines = text.length === 0 ? 0 : text.split(/\r\n|\n|\r/).length;
    const trimmed = text.trim();
    const paragraphs =
      trimmed.length === 0
        ? 0
        : trimmed.split(/(?:\r\n|\n|\r)\s*(?:\r\n|\n|\r)+/).filter(Boolean).length;
    const sentences = this.countSentences(trimmed);
    return {
      characters: text.length,
      characters_no_whitespace: text.replace(/\s/g, "").length,
      words,
      lines,
      paragraphs,
      sentences,
    };
  }

  private countSentences(text: string): number {
    if (!text) return 0;
    const matches = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
    return matches ? matches.length : 0;
  }

  private buildTopCharacters(
    text: string,
    limit: number,
  ): Array<{
    character: string;
    count: number;
  }> {
    const frequency = new Map<string, number>();
    for (const char of text) {
      frequency.set(char, (frequency.get(char) || 0) + 1);
    }

    return Array.from(frequency.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, limit)
      .map(([character, count]) => ({
        character: this.displayCharacter(character),
        count,
      }));
  }

  private displayCharacter(character: string): string {
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    if (character === " ") return "[space]";
    return character;
  }
}
