import { describe, expect, it } from "vitest";
import {
  answerLinksOutput,
  buildUnlinkedSourceCellsFinding,
  buildVerificationRepairStepContext,
  buildVerificationSeverityGuidance,
  decideVerificationRepair,
  extractVerificationFindings,
  findUnlinkedSourcedTableCells,
  isBlockingVerificationVerdict,
  isLocalizedCheckStepDescription,
  mentionsOfficeArtifact,
  requestsFileLinks,
  requestsFinalOutputsCheck,
  requestsLinksToSeveralNamedFiles,
  requestsMatchingOutputs,
  requestsSourceLinks,
  requestsSourcedResearchAnswer,
} from "../executor-verification-repair-utils";

const base = {
  failureReason: "",
  isFinalVerification: true,
  isRecheckStep: false,
  repairPassesUsed: 0,
  priorRepairAttemptInStep: false,
  budgetAvailable: true,
};

describe("decideVerificationRepair", () => {
  it("repairs a blocking final verification with concrete findings", () => {
    expect(
      decideVerificationRepair({
        ...base,
        verdictText:
          "FAIL_BLOCKING — O PDF tem 3 páginas, não 2; a secção «Decisões em aberto» fica dividida.",
      }),
    ).toEqual({
      repair: true,
      findings: "O PDF tem 3 páginas, não 2; a secção «Decisões em aberto» fica dividida.",
    });
  });

  it("reads the verdict from the recorded step error when the reply is not available", () => {
    const decision = decideVerificationRepair({
      ...base,
      verdictText: "",
      failureReason:
        "Verification failed: FAIL_BLOCKING — The Teams row has no direct source link.",
    });
    expect(decision).toEqual({
      repair: true,
      findings: "The Teams row has no direct source link.",
    });
  });

  it.each([
    ["WARN_NON_BLOCKING — the heading could be larger.", "not_blocking_verdict"],
    ["PENDING_USER_ACTION — confirm the client's legal name.", "not_blocking_verdict"],
    ["The workbook looks incomplete.", "not_blocking_verdict"],
    [
      "FAIL_BLOCKING — The user must provide the client's VAT number.",
      "needs_user_or_external_access",
    ],
    [
      "FAIL_BLOCKING — The vendor page could not be fetched (403 Forbidden).",
      "needs_user_or_external_access",
    ],
    ["FAIL_BLOCKING — Sign-in required to open the shared drive.", "needs_user_or_external_access"],
  ])("does not repair %j", (verdictText, reason) => {
    expect(decideVerificationRepair({ ...base, verdictText })).toEqual({ repair: false, reason });
  });

  it("allows one repair pass per task and none from the re-check step", () => {
    const verdictText = "FAIL_BLOCKING — The PDF has 3 pages.";
    expect(decideVerificationRepair({ ...base, verdictText, repairPassesUsed: 1 })).toEqual({
      repair: false,
      reason: "repair_already_used",
    });
    expect(decideVerificationRepair({ ...base, verdictText, isRecheckStep: true })).toEqual({
      repair: false,
      reason: "recheck_step",
    });
  });

  it("does not repair mid-plan checks, out-of-budget tasks, or empty findings", () => {
    const verdictText = "FAIL_BLOCKING — The PDF has 3 pages.";
    expect(decideVerificationRepair({ ...base, verdictText, isFinalVerification: false })).toEqual({
      repair: false,
      reason: "not_final_verification",
    });
    expect(decideVerificationRepair({ ...base, verdictText, budgetAvailable: false })).toEqual({
      repair: false,
      reason: "budget_exhausted",
    });
    expect(decideVerificationRepair({ ...base, verdictText: "FAIL_BLOCKING" })).toEqual({
      repair: false,
      reason: "no_findings",
    });
  });
});

describe("verification verdict helpers", () => {
  it("recognizes FAIL_BLOCKING in a reply or a step error, including markdown emphasis", () => {
    expect(isBlockingVerificationVerdict("**FAIL_BLOCKING** — missing totals")).toBe(true);
    expect(isBlockingVerificationVerdict("Verification failed: FAIL_BLOCKING: x")).toBe(true);
    expect(isBlockingVerificationVerdict("Verification failed: missing artifact")).toBe(false);
    expect(isBlockingVerificationVerdict("OK")).toBe(false);
  });

  it("strips the protocol token and failure prefix from findings", () => {
    expect(
      extractVerificationFindings("Verification failed: FAIL_BLOCKING: Totals are wrong."),
    ).toBe("Totals are wrong.");
    expect(extractVerificationFindings("**FAIL_BLOCKING** - Totals are wrong.")).toBe(
      "Totals are wrong.",
    );
  });

  it("detects Office and PDF deliverables", () => {
    expect(mentionsOfficeArtifact(["Create Northstar-pilot-costs.xlsx"])).toBe(true);
    expect(mentionsOfficeArtifact(["Save a matching PDF"])).toBe(true);
    expect(mentionsOfficeArtifact(["Write notes.md", undefined])).toBe(false);
  });
});

const NORTHSTAR_PROMPT =
  "Prepare a polished two-page client brief in Portuguese (Portugal) for the Northstar onboarding pilot. " +
  "Save both an editable Word document and a matching PDF: Northstar-brief.docx and Northstar-brief.pdf. " +
  "Label budget figures as proposed allowances. Give me links to both files.";

const TRANSCRIPTS_PROMPT =
  "Look up official documentation for Teams, Zoom and Google Meet transcript exports. " +
  "Compare licensing and limitations, with links, in chat.";

// The comparison table from a live answer whose Teams and Google Meet
// limitation cells carried no source link.
const TRANSCRIPT_COMPARISON_TABLE = [
  "| Platform | Transcript and export | Availability and access | Key limitations |",
  "|---|---|---|---|",
  "| **Microsoft Teams** | A **meeting transcript** can be downloaded after the meeting as **.docx** or **.vtt** from Chat → Recap → Transcript. [Microsoft: Start, stop, and download live transcripts](https://support.microsoft.com/en-us/teams/meetings/start-stop-and-download-live-transcripts-in-microsoft-teams-meetings) | Organizers and co-organizers can download by default. Other participants’ access depends on organization settings and organizer permissions. [Microsoft: Edit or delete a meeting transcript](https://support.microsoft.com/en-us/teams/meetings/edit-or-delete-a-meeting-transcript-in-microsoft-teams) | Transcripts are stored in the organizer’s OneDrive for Business. Cross-tenant participants may see the live transcript but not the post-meeting one; anonymous and dial-in attendees cannot view it. Admin policies can also affect access. |",
  "| **Zoom** | Zoom documents a transcript associated with a **cloud recording** and provides instructions for downloading it. [Download a conversation recording and transcript](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0057886) | Its documentation covers enabling audio transcription for cloud recordings and managing recording access: [Enable or disable audio transcription](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065911) · [Manage and share cloud recordings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067567) | The pages returned only a loading shell, so export formats, plan eligibility, and detailed download restrictions could not be verified. |",
  "| **Google Meet** | A **transcript** is saved to the organizer’s Google Drive, in the Google Meet folder and a meeting-specific subfolder. The help page describes access through email or the Calendar event but does not specify a file format. [Google: Use Transcripts with Meet](https://support.google.com/meet/answer/12849897?hl=en&co=GENIE.Platform%3DDesktop) | Listed Workspace plans include Business Standard/Plus, Enterprise Starter/Standard/Plus, Teaching and Learning Upgrade, Education Plus, and Workspace Individual. [Google: Premium Meet features](https://support.google.com/meet/answer/10459644?hl=en) | Transcription captures spoken words, not chat; chat requires a meeting recording. Transcription stops when everyone leaves, cannot be paused, and restarting creates a separate file. Storage must be available in both the organization’s and host’s Drive. |",
].join("\n");

describe("verification severity guidance", () => {
  it("makes a content difference between matching outputs and a missing file link blocking", () => {
    const guidance = buildVerificationSeverityGuidance({ prompt: NORTHSTAR_PROMPT });
    expect(guidance).toContain("Use WARN_NON_BLOCKING only for optional or cosmetic issues");
    expect(guidance).toContain(
      "Any difference between them in facts, figures, names, dates, or sections is FAIL_BLOCKING, not a warning",
    );
    expect(guidance).toContain("a requested file the answer does not link is FAIL_BLOCKING");
    expect(guidance).not.toContain("Sourced facts");
  });

  it("makes an unlinked factual cell blocking when the user asked for links", () => {
    const guidance = buildVerificationSeverityGuidance({ prompt: TRANSCRIPTS_PROMPT });
    expect(guidance).toContain("A factual cell or bullet with neither is FAIL_BLOCKING");
    expect(guidance).toContain("must name the page that was checked");
    expect(guidance).not.toContain("Matching outputs");
    expect(guidance).not.toContain("Requested links");
  });

  it("keeps only the general severity rule for a plain request", () => {
    const guidance = buildVerificationSeverityGuidance({
      prompt: "Write a short summary of the attached meeting notes.",
    });
    expect(guidance.trim().split("\n")).toHaveLength(1);
  });

  it("detects requests for matching outputs, file links, and sourced answers", () => {
    expect(requestsMatchingOutputs(NORTHSTAR_PROMPT)).toBe(true);
    expect(requestsMatchingOutputs("Export the report as a PDF version of report.docx.")).toBe(
      true,
    );
    expect(
      requestsMatchingOutputs("Write the summary.", ["/ws/summary.docx", "/ws/summary.pdf"]),
    ).toBe(true);
    expect(requestsMatchingOutputs("Create budget.xlsx and a separate memo.pdf.")).toBe(false);
    expect(requestsMatchingOutputs("Fix the pattern matching bug in parser.ts.")).toBe(false);

    expect(requestsFileLinks(NORTHSTAR_PROMPT)).toBe(true);
    expect(requestsFileLinks(TRANSCRIPTS_PROMPT)).toBe(false);

    expect(requestsSourceLinks(TRANSCRIPTS_PROMPT)).toBe(true);
    expect(requestsSourceLinks(NORTHSTAR_PROMPT)).toBe(false);
    expect(requestsSourcedResearchAnswer(TRANSCRIPTS_PROMPT)).toBe(true);
    expect(requestsSourcedResearchAnswer("Compare React and Vue for a small dashboard.")).toBe(
      false,
    );
    expect(requestsSourcedResearchAnswer("What is the capital of Portugal?")).toBe(false);
    expect(requestsSourcedResearchAnswer(NORTHSTAR_PROMPT)).toBe(false);
  });
});

describe("findUnlinkedSourcedTableCells", () => {
  it("flags the factual cells without a link in the live comparison answer", () => {
    const answer = `Here is the comparison.\n\n${TRANSCRIPT_COMPARISON_TABLE}\n**Terminology:** ...`;
    expect(findUnlinkedSourcedTableCells(answer)).toEqual([
      { row: "Microsoft Teams", column: "Key limitations" },
      { row: "Google Meet", column: "Key limitations" },
    ]);
  });

  it("passes the same table once every factual cell is linked or cited", () => {
    const linked = TRANSCRIPT_COMPARISON_TABLE.split("\n")
      .map((line) =>
        line.startsWith("| **Microsoft Teams**") || line.startsWith("| **Google Meet**")
          ? line.replace(/ \|\s*$/, " [1] |")
          : line,
      )
      .join("\n");
    expect(findUnlinkedSourcedTableCells(linked)).toEqual([]);
  });

  it("accepts a linked source column and ignores tables that cite nothing", () => {
    const withSourceColumn = [
      "| Platform | Limits | Source |",
      "|---|---|---|",
      "| Teams | Transcripts are stored in the organizer's OneDrive. | [Docs](https://example.com/teams) |",
    ].join("\n");
    expect(findUnlinkedSourcedTableCells(withSourceColumn)).toEqual([]);

    const unsourced = [
      "| Platform | Limits |",
      "|---|---|",
      "| Teams | Transcripts are stored in the organizer's OneDrive. |",
    ].join("\n");
    expect(findUnlinkedSourcedTableCells(unsourced)).toEqual([]);
  });

  it("names the cells in a finding the repair pass can act on", () => {
    const finding = buildUnlinkedSourceCellsFinding([
      { row: "Microsoft Teams", column: "Key limitations" },
    ]);
    expect(finding).toContain("Microsoft Teams / Key limitations");
    expect(
      decideVerificationRepair({ ...base, verdictText: `FAIL_BLOCKING — ${finding}` }),
    ).toEqual({ repair: true, findings: finding });
  });
});

describe("verification repair step guidance", () => {
  it("regenerates every matching copy, links every requested file, and forbids invented URLs", () => {
    const context = buildVerificationRepairStepContext("The DOCX lists the allowances as TBD.");
    expect(context).toContain("regenerate every other copy from that corrected content");
    expect(context).toContain("Link every file the user asked for");
    expect(context).toContain("Never invent, guess, or construct URLs");
    expect(context).toContain("reword it as not documented");
  });
});

describe("answerLinksOutput", () => {
  it("matches relative and absolute sandbox links to a workspace output", () => {
    const answer =
      "[Transferir Northstar-brief.pdf](sandbox:/var/folders/ts/T/ui-session/Northstar-brief.pdf)";
    expect(answerLinksOutput(answer, "Northstar-brief.pdf")).toBe(true);
    expect(answerLinksOutput(answer, "Northstar-brief.docx")).toBe(false);
    expect(answerLinksOutput("[Brief](Northstar-brief.docx)", "Northstar-brief.docx")).toBe(true);
    expect(answerLinksOutput("Saved Northstar-brief.docx.", "Northstar-brief.docx")).toBe(false);
  });
});

describe("isLocalizedCheckStepDescription", () => {
  it("recognises check steps in common languages", () => {
    for (const description of [
      "Verificar que ambos os ficheiros existem e são válidos, que o PDF tem duas páginas e que os documentos incluem as datas, valores, responsáveis, decisões em aberto, acentos, símbolo € e numeração de páginas esperados.",
      "Confirmar que os dois ficheiros têm os mesmos valores.",
      "Validar o PDF contra o documento Word.",
      "Rever os dois documentos e confirmar que coincidem.",
      "Comprobar que ambos archivos existen y tienen el mismo contenido.",
      "Revisar que el PDF tenga dos páginas.",
      "Vérifier que les deux fichiers existent et sont identiques.",
      "Contrôler la pagination du PDF.",
      "Überprüfen, ob beide Dateien vorhanden sind.",
      "Prüfen, ob das PDF zwei Seiten hat.",
      "Verificare che entrambi i file esistano e coincidano.",
      "Controllare le cifre nel PDF.",
      "Controleren of beide bestanden bestaan.",
      "Verifiëren dat de PDF twee pagina's heeft.",
      "**Verificar** que os ficheiros foram guardados e exportados.",
    ]) {
      expect(isLocalizedCheckStepDescription(description), description).toBe(true);
    }
  });

  it("leaves creation, mixed and English steps alone", () => {
    for (const description of [
      "Criar Northstar-brief.docx com título e visão geral.",
      "Exportar Northstar-brief.pdf a partir do documento Word.",
      "Verificar o rascunho e corrigir os valores errados.",
      "Verificar os dados e depois criar o PDF.",
      "Comprobar los totales y luego generar el informe.",
      "Vérifier les montants puis exporter le PDF.",
      "Prüfen, ob Daten fehlen, und dann den Bericht erstellen.",
      "Verificare i dati e poi creare il documento.",
      "Controleer de cijfers en maak het rapport.",
      "Revise the draft for tone.",
      "Verify both files exist.",
      "Verificação final",
    ]) {
      expect(isLocalizedCheckStepDescription(description), description).toBe(false);
    }
  });
});

describe("requestsFinalOutputsCheck", () => {
  it("covers matching outputs and links to several named files", () => {
    expect(
      requestsFinalOutputsCheck(
        "Save both an editable Word document and a matching PDF: Northstar-brief.docx and Northstar-brief.pdf. Give me links to both files.",
      ),
    ).toBe(true);
    expect(
      requestsLinksToSeveralNamedFiles(
        "Create budget.xlsx and summary.docx, and give me links to both files.",
      ),
    ).toBe(true);
    expect(
      requestsFinalOutputsCheck(
        "Create budget.xlsx and summary.docx, and give me links to both files.",
      ),
    ).toBe(true);
  });

  it("is false for a single file or no link request", () => {
    expect(
      requestsFinalOutputsCheck(
        "Create a two-page brief as Northstar-brief.docx and give me a link to the file.",
      ),
    ).toBe(false);
    expect(requestsLinksToSeveralNamedFiles("Create budget.xlsx and summary.docx.")).toBe(false);
  });
});
