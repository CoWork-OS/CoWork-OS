import { describe, expect, it } from "vitest";
import {
  responseLooksLikeUnexecutedToolCall,
  sanitizeToolCallTextFromAssistant,
} from "../tool-call-text-sanitizer";

describe("sanitizeToolCallTextFromAssistant", () => {
  it("removes xml-style tool call markup", () => {
    const result = sanitizeToolCallTextFromAssistant(
      'Before<tool_call><tool_name>run_command</tool_name><parameters>{"command":"pwd"}</parameters></tool_call>After',
    );

    expect(result.text).toBe("BeforeAfter");
    expect(result.hadToolCallText).toBe(true);
  });

  it("suppresses plain-text run_command transcripts", () => {
    const result = sanitizeToolCallTextFromAssistant(
      'to=run_command џьjson\n{"command":"git status --short","cwd":"/tmp/repo"}\nassistant to=run_command մեկնաբանություն\n{"command":"git diff --stat","cwd":"/tmp/repo","timeout_ms":1000}',
    );

    expect(result.text).toBe("");
    expect(result.hadToolCallText).toBe(true);
    expect(result.removedSegments).toBeGreaterThan(0);
  });

  it("strips skill_list-style transcript noise before the real payload", () => {
    const result = sanitizeToolCallTextFromAssistant(
      '{}【analysis to=skill_list code:\n{"description":"Execution plan","steps":[{"id":"1","description":"Review the repo."}]}',
    );

    expect(result.text).toBe(
      '{"description":"Execution plan","steps":[{"id":"1","description":"Review the repo."}]}',
    );
    expect(result.hadToolCallText).toBe(true);
  });

  it("strips same-line skill_list transcript prefixes before the real payload", () => {
    const result = sanitizeToolCallTextFromAssistant(
      '{}【analysis to=skill_list code: {"description":"Execution plan","steps":[{"id":"1","description":"Review the repo."}]}',
    );

    expect(result.text).toBe(
      '{"description":"Execution plan","steps":[{"id":"1","description":"Review the repo."}]}',
    );
    expect(result.hadToolCallText).toBe(true);
  });

  it("strips mixed leading transcript noise after an empty object and preserves inline JSON", () => {
    const result = sanitizeToolCallTextFromAssistant(
      '{}\n【analysis to=skill_list code: {"description":"Execution plan","steps":[{"id":"1","description":"Review the repo."}]}',
    );

    expect(result.text).toBe(
      '{"description":"Execution plan","steps":[{"id":"1","description":"Review the repo."}]}',
    );
    expect(result.hadToolCallText).toBe(true);
  });

  it("keeps normal prose that merely mentions commands", () => {
    const result = sanitizeToolCallTextFromAssistant(
      "I ran git status locally and the working tree is clean.",
    );

    expect(result.text).toBe("I ran git status locally and the working tree is clean.");
    expect(result.hadToolCallText).toBe(false);
  });

  it("removes inline tool json plus generic tool tags from mixed progress text", () => {
    const result = sanitizeToolCallTextFromAssistant(
      'Tackling: {"id":"call_skill_list","tool":"skill_list","input":{}} <tool name="skill_list">{}</tool>\n{"tool_name":"list_directory","arguments":"{\\"path\\":\\".\\"}"} {"description":"Assuming the goal is a publication-safe analysis","steps":[]}',
    );

    expect(result.text).toBe(
      'Tackling:\n{"description":"Assuming the goal is a publication-safe analysis","steps":[]}',
    );
    expect(result.hadToolCallText).toBe(true);
  });

  it("removes standalone namespaced tool tags", () => {
    const result = sanitizeToolCallTextFromAssistant(
      'Planner output:\n<minimax:tool_call>\ntask_list_create\ngoal: "Research"',
    );

    expect(result.text).toContain("Planner output:\n");
    expect(result.text).toContain('task_list_create\ngoal: "Research"');
    expect(result.hadToolCallText).toBe(true);
  });

  it("removes namespaced cowork tool_use tags while preserving surrounding plan text", () => {
    const result = sanitizeToolCallTextFromAssistant(
      'Bu kitap için bir inceleme planı oluşturuyorum.\n\n<cowork:tool_use name="list_files" input="{&quot;path&quot;: &quot;/Users/alex/Downloads/app/kitap&quot;}">',
    );

    expect(result.text).toBe("Bu kitap için bir inceleme planı oluşturuyorum.");
    expect(result.hadToolCallText).toBe(true);
  });

  it("detects complete and partial structured tool-call text", () => {
    expect(
      responseLooksLikeUnexecutedToolCall('I will check. search_web:0{"queries":["fixtures"]}'),
    ).toBe(true);
    expect(
      responseLooksLikeUnexecutedToolCall("I will check. search_web:0", { allowPartial: true }),
    ).toBe(true);
    expect(responseLooksLikeUnexecutedToolCall("I will check. search_web:0")).toBe(false);
  });

  it("detects structured invoke markup but ignores code and syntax examples", () => {
    expect(responseLooksLikeUnexecutedToolCall('<invoke name="search_web">')).toBe(true);
    expect(
      responseLooksLikeUnexecutedToolCall(
        'The syntax is `<invoke name="search_web">` and it should be explained.',
      ),
    ).toBe(false);
    expect(
      responseLooksLikeUnexecutedToolCall(
        '```xml\n<invoke name="search_web"><parameter name="q">fixtures</parameter></invoke>\n```',
      ),
    ).toBe(false);
    expect(responseLooksLikeUnexecutedToolCall("For example, search_web:0{}")).toBe(false);
  });
});
