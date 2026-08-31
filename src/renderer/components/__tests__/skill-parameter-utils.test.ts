import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillParameterModal, collectSkillParameterValues } from "../SkillParameterModal";
import { buildSlashSkillPrompt } from "../skill-parameter-utils";
import type { CustomSkill } from "../../../shared/types";

const testSkill: CustomSkill = {
  id: "novelist",
  name: "Novelist",
  description: "Draft a novel from a seed concept.",
  icon: "📚",
  prompt: "Write a {{genre}} novel about {{seed}}.",
  parameters: [
    {
      name: "seed",
      type: "string",
      description: "Story seed concept",
      required: true,
    },
    {
      name: "genre",
      type: "select",
      description: "Primary genre",
      required: false,
      default: "literary",
      options: ["literary", "thriller"],
    },
  ],
  enabled: true,
};

describe("skill parameter renderer utilities", () => {
  it("shows Ask In Chat when the slash flow enables it", () => {
    const markup = renderToStaticMarkup(
      createElement(SkillParameterModal, {
        skill: testSkill,
        onSubmit: vi.fn(),
        onAskInChat: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(markup).toContain("Ask In Chat");
  });

  it("omits Ask In Chat when only the prompt-expansion flow is available", () => {
    const markup = renderToStaticMarkup(
      createElement(SkillParameterModal, {
        skill: testSkill,
        onSubmit: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(markup).not.toContain("Ask In Chat");
  });

  it("serializes slash prompts with structured parameter JSON", () => {
    expect(buildSlashSkillPrompt("novelist")).toBe("/novelist");
    expect(
      buildSlashSkillPrompt("novelist", { seed: "A locked-room mystery", genre: "thriller" }),
    ).toBe('/novelist {"seed":"A locked-room mystery","genre":"thriller"}');
  });

  it("preserves entered values and silent defaults for ask-in-chat handoff", () => {
    const values = collectSkillParameterValues(
      testSkill,
      {
        seed: "A city that forgets its citizens overnight",
        genre: "literary",
      },
      {
        seed: true,
      },
    );

    expect(values).toEqual({
      seed: "A city that forgets its citizens overnight",
      genre: "literary",
    });
  });
});
