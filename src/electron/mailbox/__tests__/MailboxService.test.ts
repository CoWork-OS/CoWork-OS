import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Any = any;

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("MailboxService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let service: import("../MailboxService").MailboxService;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let core: import("../../control-plane/ControlPlaneCoreService").ControlPlaneCoreService;
  let agentRoleRepo: import("../../agents/AgentRoleRepository").AgentRoleRepository;

  const now = Date.now();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-mailbox-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [{ DatabaseManager }, { MailboxService }, { ControlPlaneCoreService }, { AgentRoleRepository }] = await Promise.all([
      import("../../database/schema"),
      import("../MailboxService"),
      import("../../control-plane/ControlPlaneCoreService"),
      import("../../agents/AgentRoleRepository"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new MailboxService(db);
    core = new ControlPlaneCoreService(db);
    agentRoleRepo = new AgentRoleRepository(db);

    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail:test@example.com",
      "gmail",
      "test@example.com",
      "Test User",
      "connected",
      JSON.stringify(["threads", "drafts"]),
      null,
      now,
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:alpha",
      "gmail:test@example.com",
      "alpha",
      "gmail",
      "Q2 launch review",
      "Can you send the revised launch plan by tomorrow and propose times?",
      JSON.stringify([{ email: "alex@acme.com", name: "Alex" }]),
      JSON.stringify(["IMPORTANT"]),
      "priority",
      82,
      76,
      1,
      1,
      0,
      0,
      1,
      2,
      now - 2 * 60 * 60 * 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:alpha",
      "m-1",
      "incoming",
      "Alex",
      "alex@acme.com",
      JSON.stringify([{ email: "test@example.com", name: "Test User" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Q2 launch review",
      "Need revised plan",
      "Can you send the revised launch plan by tomorrow? Please also propose two meeting times for the review.",
      now - 2 * 60 * 60 * 1000,
      1,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:alpha",
      "m-2",
      "outgoing",
      "Test User",
      "test@example.com",
      JSON.stringify([{ email: "alex@acme.com", name: "Alex" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Re: Q2 launch review",
      "Working on it",
      "Hi Alex,\nI am working on the revised plan now.\n\nThanks,",
      now - 90 * 60 * 1000,
      0,
      JSON.stringify({}),
      now,
      now,
    );

  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summarizes threads, extracts commitments, and reports queue counts", async () => {
    const summary = await service.summarizeThread("gmail-thread:alpha");
    expect(summary?.summary).toContain("Can you send the revised launch plan");
    expect(summary?.suggestedNextAction).toBe("Draft a reply");

    const summaryRow = db
      .prepare("SELECT summary_text FROM mailbox_summaries WHERE thread_id = ?")
      .get("gmail-thread:alpha") as { summary_text: string };
    expect(summaryRow.summary_text.startsWith("mbox:")).toBe(true);

    const commitments = await service.extractCommitments("gmail-thread:alpha");
    expect(commitments.length).toBeGreaterThan(0);
    expect(commitments[0]?.title.toLowerCase()).toContain("revised launch plan");

    const commitmentRow = db
      .prepare("SELECT source_excerpt FROM mailbox_commitments WHERE thread_id = ? LIMIT 1")
      .get("gmail-thread:alpha") as { source_excerpt: string };
    expect(commitmentRow.source_excerpt.startsWith("mbox:")).toBe(true);

    const followups = await service.reviewBulkAction({ type: "follow_up", limit: 10 });
    expect(followups.count).toBeGreaterThan(0);
    expect(followups.proposals[0]?.threadId).toBe("gmail-thread:alpha");

    const detail = await service.getThread("gmail-thread:alpha");
    expect(detail?.summary?.keyAsks.length).toBeGreaterThan(0);
    expect(detail?.commitments.length).toBeGreaterThan(0);

    const status = await service.getSyncStatus();
    expect(status.threadCount).toBe(1);
    expect(status.needsReplyCount).toBe(1);
    expect(status.commitmentCount).toBeGreaterThan(0);
  });

  it("stores schedule suggestions in a thread proposal preview", async () => {
    const scheduled = await service.scheduleReply("gmail-thread:alpha");
    expect(scheduled.threadId).toBe("gmail-thread:alpha");
    expect(scheduled.suggestions.length).toBeGreaterThan(0);

    const detail = await service.getThread("gmail-thread:alpha");
    const scheduleProposal = detail?.proposals.find(
      (proposal) => proposal.type === "schedule" && proposal.status === "suggested",
    );

    expect(scheduleProposal).toBeTruthy();
    expect(scheduleProposal?.preview).toMatchObject({
      suggestions: scheduled.suggestions,
    });
    expect(Array.isArray(scheduleProposal?.preview?.slotOptions)).toBe(true);
  });

  it("allows generated drafts to be discarded", async () => {
    const draft = await service.generateDraft("gmail-thread:alpha");
    expect(draft).toBeTruthy();

    const storedDraft = db
      .prepare("SELECT body_text FROM mailbox_drafts WHERE id = ?")
      .get(draft?.id) as { body_text: string };
    expect(storedDraft.body_text.startsWith("mbox:")).toBe(true);

    await service.applyAction({
      threadId: "gmail-thread:alpha",
      draftId: draft?.id,
      type: "discard_draft",
    });

    const detail = await service.getThread("gmail-thread:alpha");
    expect(detail?.drafts.map((entry) => entry.id)).not.toContain(draft?.id);
    expect(detail?.proposals.some((proposal) => proposal.type === "reply" && proposal.status === "suggested")).toBe(false);
  });

  it("applies cleanup locally without mutating the mail server and restores the thread when new activity arrives", async () => {
    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:cleanup",
      "gmail:test@example.com",
      "cleanup",
      "gmail",
      "Welcome to your Google Cloud Free Trial",
      "Low-priority promotional onboarding email.",
      JSON.stringify([{ email: "noreply@google.com", name: "Google Cloud" }]),
      JSON.stringify(["CATEGORY_PROMOTIONS"]),
      "promotions",
      8,
      3,
      0,
      0,
      1,
      1,
      0,
      1,
      now - 60 * 60 * 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:cleanup",
      "m-cleanup-1",
      "incoming",
      "Google Cloud",
      "noreply@google.com",
      JSON.stringify([{ email: "test@example.com", name: "Test User" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Welcome to your Google Cloud Free Trial",
      "Free trial onboarding",
      "This is a low-priority onboarding email.",
      now - 60 * 60 * 1000,
      0,
      JSON.stringify({}),
      now,
      now,
    );

    const gmailApi = await import("../../utils/gmail-api");
    const gmailRequestSpy = vi.spyOn(gmailApi, "gmailRequest").mockResolvedValue({ data: {} } as never);

    try {
      const cleanupQueue = await service.reviewBulkAction({ type: "cleanup", limit: 10 });
      const cleanupProposal = cleanupQueue.proposals.find((proposal) => proposal.threadId === "gmail-thread:cleanup");

      expect(cleanupProposal).toBeTruthy();

      await service.applyAction({
        proposalId: cleanupProposal?.id,
        threadId: "gmail-thread:cleanup",
        type: "cleanup_local",
      });

      expect(gmailRequestSpy).not.toHaveBeenCalled();

      const hiddenRow = db
        .prepare("SELECT handled, cleanup_candidate, local_inbox_hidden FROM mailbox_threads WHERE id = ?")
        .get("gmail-thread:cleanup") as {
        handled: number;
        cleanup_candidate: number;
        local_inbox_hidden: number;
      };

      expect(hiddenRow.handled).toBe(1);
      expect(hiddenRow.cleanup_candidate).toBe(0);
      expect(hiddenRow.local_inbox_hidden).toBe(1);

      const inboxAfterCleanup = await service.listThreads({ mailboxView: "inbox", limit: 20 });
      expect(inboxAfterCleanup.map((thread) => thread.id)).not.toContain("gmail-thread:cleanup");

      const cleanupQueueAfterApply = await service.reviewBulkAction({ type: "cleanup", limit: 10 });
      expect(cleanupQueueAfterApply.proposals.map((proposal) => proposal.threadId)).not.toContain("gmail-thread:cleanup");

      await (service as Any).upsertThread({
        id: "gmail-thread:cleanup",
        accountId: "gmail:test@example.com",
        provider: "gmail",
        providerThreadId: "cleanup",
        subject: "Re: Welcome to your Google Cloud Free Trial",
        snippet: "A new reply came in.",
        participants: [{ email: "support@google.com", name: "Google Cloud Support" }],
        labels: ["CATEGORY_UPDATES"],
        category: "updates",
        priorityScore: 24,
        urgencyScore: 18,
        needsReply: false,
        staleFollowup: false,
        cleanupCandidate: false,
        handled: false,
        unreadCount: 1,
        lastMessageAt: now + 5 * 60 * 1000,
        messages: [
          {
            id: "cleanup-new-message",
            providerMessageId: "cleanup-new-message",
            direction: "incoming",
            from: { email: "support@google.com", name: "Google Cloud Support" },
            to: [{ email: "test@example.com", name: "Test User" }],
            cc: [],
            bcc: [],
            subject: "Re: Welcome to your Google Cloud Free Trial",
            snippet: "A new reply came in.",
            body: "A new reply came in.",
            receivedAt: now + 5 * 60 * 1000,
            unread: true,
          },
        ],
      });

      const storedMessage = db
        .prepare(
          "SELECT body_text, body_html FROM mailbox_messages WHERE thread_id = ? ORDER BY received_at DESC LIMIT 1",
        )
        .get("gmail-thread:cleanup") as { body_text: string; body_html: string | null };
      expect(storedMessage.body_text.startsWith("mbox:")).toBe(true);

      const inboxAfterNewActivity = await service.listThreads({ mailboxView: "inbox", limit: 20 });
      expect(inboxAfterNewActivity.map((thread) => thread.id)).toContain("gmail-thread:cleanup");

      const restoredRow = db
        .prepare("SELECT local_inbox_hidden FROM mailbox_threads WHERE id = ?")
        .get("gmail-thread:cleanup") as { local_inbox_hidden: number };
      expect(restoredRow.local_inbox_hidden).toBe(0);
    } finally {
      gmailRequestSpy.mockRestore();
    }
  });

  it("blocks noreply drafts unless the manual override is confirmed", async () => {
    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:noreply",
      "gmail:test@example.com",
      "noreply",
      "gmail",
      "Your Apple receipt",
      "This is an automated message. Do not reply.",
      JSON.stringify([{ email: "no-reply@apple.com", name: "Apple" }]),
      JSON.stringify(["CATEGORY_UPDATES"]),
      "updates",
      18,
      12,
      0,
      0,
      0,
      1,
      1,
      1,
      now - 30 * 60 * 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:noreply",
      "m-noreply-1",
      "incoming",
      "Apple",
      "no-reply@apple.com",
      JSON.stringify([{ email: "test@example.com", name: "Test User" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Your Apple receipt",
      "Automated receipt",
      "This is an automated message about your purchase. Do not reply to this email.",
      now - 30 * 60 * 1000,
      1,
      JSON.stringify({}),
      now,
      now,
    );

    const summary = await service.summarizeThread("gmail-thread:noreply");
    expect(summary?.suggestedNextAction).toBe("Keep as reference");

    await expect(service.generateDraft("gmail-thread:noreply")).rejects.toThrow(/no-reply sender/i);

    const draft = await service.generateDraft("gmail-thread:noreply", {
      tone: "concise",
      allowNoreplySender: true,
    });
    expect(draft).toBeTruthy();
    expect(draft?.subject).toBe("Re: Your Apple receipt");
  });

  it("searches sender and body content and computes contact intelligence", async () => {
    const senderMatches = await service.listThreads({ query: "alex@acme.com" });
    expect(senderMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const bodyMatches = await service.listThreads({ query: "meeting times" });
    expect(bodyMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const unreadMatches = await service.listThreads({ unreadOnly: true });
    expect(unreadMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const detail = await service.getThread("gmail-thread:alpha");
    expect(detail?.contactMemory?.recentSubjects).toContain("Q2 launch review");
    expect(detail?.contactMemory?.styleSignals?.length).toBeGreaterThan(0);
    expect(detail?.research?.relationshipSummary).toContain("Average response time");
    expect(detail?.research?.nextSteps?.length).toBeGreaterThan(0);
  });

  it("filters Today/domain buckets and includes attachment metadata in mailbox search", async () => {
    db.prepare(
      `UPDATE mailbox_threads
       SET today_bucket = ?, domain_category = ?
       WHERE id = ?`,
    ).run("needs_action", "customer", "gmail-thread:alpha");

    db.prepare(
      `INSERT INTO mailbox_attachments
        (id, thread_id, message_id, provider, provider_message_id, provider_attachment_id, filename, mime_type, size, extraction_status, extraction_error, metadata_json, created_at, updated_at)
       VALUES (?, ?, (SELECT id FROM mailbox_messages WHERE thread_id = ? LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "att-alpha-contract",
      "gmail-thread:alpha",
      "gmail-thread:alpha",
      "gmail",
      "m-1",
      "gmail-att-1",
      "launch-contract.pdf",
      "application/pdf",
      1200,
      "not_indexed",
      null,
      JSON.stringify({}),
      now,
      now,
    );

    const todayMatches = await service.listThreads({ todayBucket: "needs_action" });
    expect(todayMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");
    expect(todayMatches[0]?.todayBucket).toBe("needs_action");
    expect(todayMatches[0]?.domainCategory).toBe("customer");
    expect(todayMatches[0]?.attachments?.[0]?.filename).toBe("launch-contract.pdf");

    const attachmentMatches = await service.listThreads({ attachmentQuery: "contract" });
    expect(attachmentMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const fetchAttachmentBytesSpy = vi
      .spyOn(service as Any, "fetchMailboxAttachmentBytes")
      .mockResolvedValue(Buffer.from("ignored"));
    const extractAttachmentTextSpy = vi
      .spyOn(service as Any, "extractTextFromAttachmentBytes")
      .mockResolvedValue({ text: "Executed renewal clause for the launch agreement.", mode: "plain-text" });

    await service.extractMailboxAttachmentText("att-alpha-contract");

    const attachmentTextMatches = await service.listThreads({ attachmentQuery: "renewal clause" });
    expect(attachmentTextMatches.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    fetchAttachmentBytesSpy.mockRestore();
    extractAttachmentTextSpy.mockRestore();
  });

  it("builds sender cleanup and mailbox ask results from local evidence", async () => {
    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, today_bucket, domain_category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:newsletter",
      "gmail:test@example.com",
      "newsletter",
      "gmail",
      "Weekly product digest",
      "A digest you can clean up.",
      JSON.stringify([{ email: "news@example.com", name: "News" }]),
      JSON.stringify([]),
      "updates",
      "more_to_browse",
      "newsletters",
      5,
      0,
      0,
      0,
      1,
      1,
      0,
      1,
      now - 2000,
      now,
      JSON.stringify({}),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:newsletter",
      "m-news",
      "incoming",
      "News",
      "news@example.com",
      JSON.stringify([{ email: "test@example.com", name: "Test User" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Weekly product digest",
      "A digest you can clean up.",
      "Weekly product updates and links.",
      now - 2000,
      0,
      JSON.stringify({}),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO mailbox_search_fts
         (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
       VALUES ('message', ?, ?, ?, NULL, ?, ?, ?, '', '')`,
    ).run(
      "stale-newsletter-fts",
      "gmail-thread:newsletter",
      "m-news",
      "Launch plan digest",
      "news@example.com",
      "An unrelated launch plan mention already present in the FTS table.",
    );

    const senderDigest = await service.getMailboxSenderCleanupDigest({ limit: 5 });
    expect(senderDigest.senders.some((sender) => sender.email === "news@example.com")).toBe(true);

    const ask = await service.askMailbox({ query: "launch plan", includeAnswer: false });
    expect(ask.results.map((result) => result.thread.id)).toContain("gmail-thread:alpha");
    expect(ask.usedLlm).toBe(false);
  });

  it("filters threads by suggested proposals and open commitments", async () => {
    await service.summarizeThread("gmail-thread:alpha");
    await service.extractCommitments("gmail-thread:alpha");

    const queueThreads = await service.listThreads({ hasSuggestedProposal: true });
    expect(queueThreads.map((thread) => thread.id)).toContain("gmail-thread:alpha");

    const commitmentThreads = await service.listThreads({ hasOpenCommitment: true });
    expect(commitmentThreads.map((thread) => thread.id)).toContain("gmail-thread:alpha");
  });

  it("creates a follow-up task when a commitment is accepted and syncs done/dismissed states", async () => {
    const workspaceId = "workspace-follow-up";
    db.prepare(
      `INSERT INTO workspaces
        (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "Main Workspace",
      "/tmp/main-workspace",
      now,
      now,
      JSON.stringify({
        read: true,
        write: true,
        delete: false,
        network: true,
        shell: false,
      }),
    );

    const commitmentId = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_commitments
        (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commitmentId,
      "gmail-thread:alpha",
      null,
      "Send the revised launch plan",
      now + 24 * 60 * 60 * 1000,
      "suggested",
      "alex@acme.com",
      "Please send the revised launch plan by tomorrow.",
      JSON.stringify({}),
      now,
      now,
    );

    const { TaskRepository } = await import("../../database/repositories");
    const taskRepo = new TaskRepository(db);

    const accepted = await service.updateCommitmentState(commitmentId, "accepted");
    expect(accepted?.state).toBe("accepted");
    expect(accepted?.followUpTaskId).toBeTruthy();

    const acceptedTask = taskRepo.findById(accepted?.followUpTaskId || "");
    expect(acceptedTask?.title).toContain("Follow up:");
    expect(acceptedTask?.workspaceId).toBe(workspaceId);
    expect(acceptedTask?.status).toBe("pending");
    expect(acceptedTask?.dueDate).toBe(now + 24 * 60 * 60 * 1000);

    const done = await service.updateCommitmentState(commitmentId, "done");
    expect(done?.state).toBe("done");
    expect(taskRepo.findById(accepted?.followUpTaskId || "")?.status).toBe("completed");

    const dismissedCommitmentId = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_commitments
        (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      dismissedCommitmentId,
      "gmail-thread:alpha",
      null,
      "Confirm the meeting time",
      null,
      "suggested",
      "alex@acme.com",
      "Please confirm the meeting time.",
      JSON.stringify({}),
      now,
      now,
    );

    const dismissedAccepted = await service.updateCommitmentState(dismissedCommitmentId, "accepted");
    expect(dismissedAccepted?.followUpTaskId).toBeTruthy();
    await service.updateCommitmentState(dismissedCommitmentId, "dismissed");
    expect(taskRepo.findById(dismissedAccepted?.followUpTaskId || "")?.status).toBe("cancelled");
  });

  it("sorts threads by recency or priority when requested", async () => {
    const older = now - 5 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:beta",
      "gmail:test@example.com",
      "beta",
      "gmail",
      "Priority follow-up",
      "Old but urgent",
      JSON.stringify([{ email: "sam@acme.com", name: "Sam" }]),
      JSON.stringify(["IMPORTANT"]),
      "priority",
      95,
      90,
      1,
      1,
      0,
      0,
      1,
      1,
      older,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:beta",
      "m-beta-1",
      "outgoing",
      "Test User",
      "test@example.com",
      JSON.stringify([{ email: "sam@acme.com", name: "Sam" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Re: Priority follow-up",
      "Old but urgent",
      "Following up on the item you sent.",
      older,
      0,
      JSON.stringify({}),
      now,
      now,
    );

    const recentThreads = await service.listThreads({ sortBy: "recent" });
    expect(recentThreads[0]?.id).toBe("gmail-thread:alpha");

    const priorityThreads = await service.listThreads({ sortBy: "priority" });
    expect(priorityThreads[0]?.id).toBe("gmail-thread:beta");

    const inboxThreads = await service.listThreads({ mailboxView: "inbox" });
    expect(inboxThreads.map((thread) => thread.id)).not.toContain("gmail-thread:beta");

    const sentThreads = await service.listThreads({ mailboxView: "sent" });
    expect(sentThreads.map((thread) => thread.id)).toContain("gmail-thread:beta");
  });

  it("applies the unread filter when requested", async () => {
    const unreadThreads = await service.listThreads({ unreadOnly: true });
    expect(unreadThreads.every((thread) => thread.unreadCount > 0)).toBe(true);
  });

  it("filters threads by mailbox account when requested", async () => {
    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "imap:user@msn.com",
      "imap",
      "user@msn.com",
      "MSN Mail",
      "connected",
      JSON.stringify(["send", "mark_read"]),
      null,
      now,
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "imap-thread:msn-alpha",
      "imap:user@msn.com",
      "msn-alpha",
      "imap",
      "MSN follow-up",
      "Need a reply from Outlook inbox",
      JSON.stringify([{ email: "owner@contoso.com", name: "Owner" }]),
      JSON.stringify([]),
      "follow_up",
      60,
      55,
      1,
      0,
      0,
      0,
      1,
      1,
      now - 30 * 60 * 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "imap-thread:msn-alpha",
      "901",
      "incoming",
      "Owner",
      "owner@contoso.com",
      JSON.stringify([{ email: "user@msn.com", name: "MSN Mail" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "MSN follow-up",
      "Need a reply from Outlook inbox",
      "Can you respond from the MSN account?",
      now - 30 * 60 * 1000,
      1,
      JSON.stringify({}),
      now,
      now,
    );

    const gmailThreads = await service.listThreads({ accountId: "gmail:test@example.com" });
    expect(gmailThreads.map((thread) => thread.id)).toEqual(["gmail-thread:alpha"]);

    const imapThreads = await service.listThreads({ accountId: "imap:user@msn.com" });
    expect(imapThreads.map((thread) => thread.id)).toEqual(["imap-thread:msn-alpha"]);
  });

  it("normalizes structured IMAP addresses and html content from the email client", () => {
    const normalized = (service as any).normalizeImapThreads("imap:user@msn.com", "user@msn.com", [
      {
        uid: 901,
        messageId: "msg-901@example.com",
        from: {
          name: "Microsoft account team",
          address: "account-security-noreply@accountprotection.microsoft.com",
        },
        to: [{ name: "Recipient", address: "user@msn.com" }],
        subject: "Microsoft hesabınıza yeni uygulamalar bağlandı",
        html: "<p>MSN Mail App, test</p><p>Review this sign-in.</p>",
        date: new Date(now).toISOString(),
        isRead: false,
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.id).toBe(
      "imap-thread:microsoft hesabınıza yeni uygulamalar bağlandı::account-security-noreply@accountprotection.microsoft.com",
    );
    expect(normalized[0]?.participants).toEqual([
      {
        email: "account-security-noreply@accountprotection.microsoft.com",
        name: "Microsoft account team",
      },
    ]);
    expect(normalized[0]?.messages[0]?.from).toEqual({
      email: "account-security-noreply@accountprotection.microsoft.com",
      name: "Microsoft account team",
    });
    expect(normalized[0]?.messages[0]?.to).toEqual([
      {
        email: "user@msn.com",
        name: "Recipient",
      },
    ]);
    expect(normalized[0]?.messages[0]?.body).toBe("MSN Mail App, test\n\nReview this sign-in.");
    expect(normalized[0]?.messages[0]?.bodyHtml).toContain("<p>MSN Mail App, test</p>");
    expect(normalized[0]?.messages[0]?.metadata).toMatchObject({
      imapUid: 901,
      rfcMessageId: "msg-901@example.com",
    });
  });

  it("recovers a legacy IMAP message-id and marks the thread read", async () => {
    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "imap:user@msn.com",
      "imap",
      "user@msn.com",
      "MSN Mail",
      "connected",
      JSON.stringify(["send", "mark_read"]),
      null,
      now,
      now,
      now,
    );

    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "imap-thread:legacy-mark-read",
      "imap:user@msn.com",
      "legacy-mark-read",
      "imap",
      "Legacy IMAP thread",
      "Unread message synced before UID metadata existed.",
      JSON.stringify([{ email: "sender@example.com", name: "Sender" }]),
      JSON.stringify([]),
      "other",
      35,
      22,
      0,
      0,
      0,
      0,
      1,
      1,
      now - 5 * 60 * 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );

    const legacyMessageRowId = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      legacyMessageRowId,
      "imap-thread:legacy-mark-read",
      "legacy-message-id@example.com",
      "incoming",
      "Sender",
      "sender@example.com",
      JSON.stringify([{ email: "user@msn.com", name: "MSN Mail" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Legacy IMAP thread",
      "Unread message synced before UID metadata existed.",
      "Please mark this thread as read.",
      now - 5 * 60 * 1000,
      1,
      JSON.stringify({}),
      now,
      now,
    );

    const findByTypeSpy = vi.spyOn((service as Any).channelRepo, "findByType").mockReturnValue({
      id: "email-channel",
      enabled: true,
      config: {
        protocol: "imap-smtp",
      },
    } as never);
    const fetchRecentEmails = vi.fn().mockResolvedValue([
      {
        uid: 901,
        messageId: "legacy-message-id@example.com",
        from: { name: "Sender", address: "sender@example.com" },
        to: [{ name: "MSN Mail", address: "user@msn.com" }],
        cc: [],
        subject: "Legacy IMAP thread",
        text: "Please mark this thread as read.",
        date: new Date(now - 5 * 60 * 1000),
        isRead: false,
        headers: new Map(),
      },
    ]);
    const markAsRead = vi.fn().mockResolvedValue(undefined);
    const createStandardEmailClientSpy = vi.spyOn(service as Any, "createStandardEmailClient").mockReturnValue({
      fetchRecentEmails,
      markAsRead,
    } as never);

    try {
      await expect(
        service.applyAction({
          threadId: "imap-thread:legacy-mark-read",
          type: "mark_read",
        }),
      ).resolves.toMatchObject({
        success: true,
        action: "mark_read",
        threadId: "imap-thread:legacy-mark-read",
      });

      expect(fetchRecentEmails).toHaveBeenCalled();
      expect(markAsRead).toHaveBeenCalledWith(901);

      const messageRow = db
        .prepare("SELECT is_unread, metadata_json FROM mailbox_messages WHERE id = ?")
        .get(legacyMessageRowId) as { is_unread: number; metadata_json: string | null };
      expect(messageRow.is_unread).toBe(0);
      expect(JSON.parse(messageRow.metadata_json || "{}")).toMatchObject({
        imapUid: 901,
        rfcMessageId: "legacy-message-id@example.com",
      });

      const threadRow = db
        .prepare("SELECT unread_count FROM mailbox_threads WHERE id = ?")
        .get("imap-thread:legacy-mark-read") as { unread_count: number };
      expect(threadRow.unread_count).toBe(0);
    } finally {
      createStandardEmailClientSpy.mockRestore();
      findByTypeSpy.mockRestore();
    }
  });

  it("does not treat onboarding or automated mail as priority follow-up", async () => {
    const normalized = (service as any).normalizeGmailThread(
      "gmail:test@example.com",
      "test@example.com",
      {
        id: "thread-onboarding",
        messages: [
          {
            id: "m-onboarding",
            internalDate: String(now - 3 * 60 * 60 * 1000),
            snippet: "Get started fast and see what's possible.",
            labelIds: [],
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "Welcome to your Google Cloud Free Trial" },
                { name: "From", value: "Google Cloud <googlecloud-noreply@google.com>" },
                { name: "To", value: "Test User <test@example.com>" },
              ],
              body: {
                data: Buffer.from(
                  "Welcome to Google Cloud. Get started with your free trial credits today. This inbox is not monitored.",
                )
                  .toString("base64")
                  .replace(/\+/g, "-")
                  .replace(/\//g, "_")
                  .replace(/=+$/, ""),
              },
            },
          },
        ],
      },
    );

    expect(normalized.category).toBe("other");
    expect(normalized.needsReply).toBe(false);
    expect(normalized.staleFollowup).toBe(false);
    expect(normalized.priorityScore).toBeLessThan(35);
  });

  it.each([
    {
      threadId: "thread-amazon-revision",
      subject: "Revision to Your Amazon.com Account",
      from: "account-update@amazon.com",
      body: "Thanks for visiting Amazon.com! Per your request, we have updated your mobile phone information. Should you need to contact us for any reason, please know that we can give out order information only to the name and e-mail address associated with your account.",
    },
    {
      threadId: "thread-amazon-passkey",
      subject: "Passkey added to your account",
      from: "account-update@amazon.com",
      body: "Thanks for visiting Amazon! You have successfully added a passkey to your account. If you have questions, please contact us.",
    },
    {
      threadId: "thread-amazon-kdp",
      subject: "Recent update to your Kindle Direct Publishing account",
      from: "kdp-noreply@amazon.com",
      body: "Hello, we are sending this update to let you know your account settings have changed. This inbox is not monitored.",
    },
  ])("does not classify transactional Amazon notifications as reply-needed", async ({ threadId, subject, from, body }) => {
    const normalized = (service as any).normalizeGmailThread(
      "gmail:test@example.com",
      "test@example.com",
      {
        id: threadId,
        messages: [
          {
            id: `${threadId}-message`,
            internalDate: String(now - 2 * 60 * 60 * 1000),
            snippet: body.slice(0, 80),
            labelIds: [],
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: subject },
                { name: "From", value: `Amazon <${from}>` },
                { name: "To", value: "Test User <test@example.com>" },
              ],
              body: {
                data: Buffer.from(body)
                  .toString("base64")
                  .replace(/\+/g, "-")
                  .replace(/\//g, "_")
                  .replace(/=+$/, ""),
              },
            },
          },
        ],
      },
    );

    expect(normalized.needsReply).toBe(false);
    expect(normalized.category).toBe("other");
    expect(normalized.staleFollowup).toBe(false);
  });

  it("persists LLM mailbox classifications and stores their provenance", async () => {
    const factoryModule = await import("../agent/llm/provider-factory");
    const loadSettingsSpy = vi.spyOn(factoryModule.LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        model: "gpt-4o-mini",
        automatedTaskModelKey: "gpt-4o-mini",
        cheapModelKey: "gpt-4o-mini",
      },
    } as never);
    const routingSpy = vi.spyOn(factoryModule.LLMProviderFactory, "getProviderRoutingSettings").mockReturnValue({
      profileRoutingEnabled: true,
      preferStrongForVerification: false,
      strongModelKey: "gpt-4o",
      cheapModelKey: "gpt-4o-mini",
      automatedTaskModelKey: "gpt-4o-mini",
    });
    const resolveSpy = vi.spyOn(factoryModule.LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openai",
      modelId: "gpt-4o-mini",
      modelKey: "gpt-4o-mini",
      llmProfileUsed: "cheap",
      resolvedModelKey: "gpt-4o-mini",
      modelSource: "profile_model",
      warnings: [],
    });
    const createProviderSpy = vi.spyOn(factoryModule.LLMProviderFactory, "createProvider").mockReturnValue({
      type: "openai",
      createMessage: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              category: "updates",
              needsReply: false,
              priorityScore: 12,
              urgencyScore: 4,
              staleFollowup: false,
              cleanupCandidate: false,
              handled: true,
              confidence: 0.94,
              rationale: "Transactional notice with no reply requested.",
              labels: ["transactional", "account"],
            }),
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30 },
      }),
    } as never);

    try {
      const result = await service.reclassifyThread("gmail-thread:alpha");
      expect(result.reclassifiedThreads).toBe(1);

      const row = db
        .prepare(
          `SELECT category, needs_reply, priority_score, urgency_score, classification_state,
                  classification_model_key, classification_prompt_version, classification_confidence,
                  classification_fingerprint, classification_json
           FROM mailbox_threads
           WHERE id = ?`,
        )
        .get("gmail-thread:alpha") as {
        category: string;
        needs_reply: number;
        priority_score: number;
        urgency_score: number;
        classification_state: string;
        classification_model_key: string | null;
        classification_prompt_version: string | null;
        classification_confidence: number;
        classification_fingerprint: string | null;
        classification_json: string | null;
      };

      expect(row.category).toBe("updates");
      expect(row.needs_reply).toBe(0);
      expect(row.priority_score).toBe(12);
      expect(row.urgency_score).toBe(4);
      expect(row.classification_state).toBe("classified");
      expect(row.classification_model_key).toBe("gpt-4o-mini");
      expect(row.classification_prompt_version).toBe("v1");
      expect(row.classification_confidence).toBeGreaterThan(0.9);
      expect(row.classification_fingerprint).toBeTruthy();
      expect(row.classification_json).toContain("transactional");

      const usageRow = db
        .prepare(
          `SELECT source_kind, model_key, input_tokens, output_tokens, success
           FROM llm_call_events
           WHERE source_kind = 'mailbox_classification'
           ORDER BY timestamp DESC
           LIMIT 1`,
        )
        .get() as {
        source_kind: string;
        model_key: string | null;
        input_tokens: number;
        output_tokens: number;
        success: number;
      };
      expect(usageRow.source_kind).toBe("mailbox_classification");
      expect(usageRow.model_key).toBe("gpt-4o-mini");
      expect(usageRow.input_tokens).toBe(100);
      expect(usageRow.output_tokens).toBe(30);
      expect(usageRow.success).toBe(1);
    } finally {
      loadSettingsSpy.mockRestore();
      routingSpy.mockRestore();
      resolveSpy.mockRestore();
      createProviderSpy.mockRestore();
    }
  });

  it("falls back conservatively when the model output is low confidence", async () => {
    const factoryModule = await import("../agent/llm/provider-factory");
    const loadSettingsSpy = vi.spyOn(factoryModule.LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        model: "gpt-4o-mini",
        automatedTaskModelKey: "gpt-4o-mini",
        cheapModelKey: "gpt-4o-mini",
      },
    } as never);
    vi.spyOn(factoryModule.LLMProviderFactory, "getProviderRoutingSettings").mockReturnValue({
      profileRoutingEnabled: true,
      preferStrongForVerification: false,
      strongModelKey: "gpt-4o",
      cheapModelKey: "gpt-4o-mini",
      automatedTaskModelKey: "gpt-4o-mini",
    });
    vi.spyOn(factoryModule.LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openai",
      modelId: "gpt-4o-mini",
      modelKey: "gpt-4o-mini",
      llmProfileUsed: "cheap",
      resolvedModelKey: "gpt-4o-mini",
      modelSource: "profile_model",
      warnings: [],
    });
    vi.spyOn(factoryModule.LLMProviderFactory, "createProvider").mockReturnValue({
      type: "openai",
      createMessage: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              category: "priority",
              needsReply: true,
              priorityScore: 97,
              urgencyScore: 91,
              staleFollowup: true,
              cleanupCandidate: false,
              handled: false,
              confidence: 0.12,
              rationale: "Not sure, maybe needs a reply?",
              labels: ["uncertain"],
            }),
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30 },
      }),
    } as never);

    try {
      await service.reclassifyThread("gmail-thread:alpha");

      const row = db
        .prepare(
          `SELECT category, needs_reply, priority_score, urgency_score, classification_confidence
           FROM mailbox_threads
           WHERE id = ?`,
        )
        .get("gmail-thread:alpha") as {
        category: string;
        needs_reply: number;
        priority_score: number;
        urgency_score: number;
        classification_confidence: number;
      };

      expect(row.category).toBe("other");
      expect(row.needs_reply).toBe(0);
      expect(row.priority_score).toBeLessThan(20);
      expect(row.urgency_score).toBeLessThan(20);
      expect(row.classification_confidence).toBeLessThan(0.2);
    } finally {
      loadSettingsSpy.mockRestore();
    }
  });

  it("does not auto-reclassify already classified threads during sync", async () => {
    const factoryModule = await import("../agent/llm/provider-factory");
    const loadSettingsSpy = vi.spyOn(factoryModule.LLMProviderFactory, "loadSettings").mockReturnValue({
      providerType: "openai",
      modelKey: "gpt-4o-mini",
      openai: {
        model: "gpt-4o-mini",
        automatedTaskModelKey: "gpt-4o-mini",
        cheapModelKey: "gpt-4o-mini",
      },
    } as never);
    vi.spyOn(factoryModule.LLMProviderFactory, "getProviderRoutingSettings").mockReturnValue({
      profileRoutingEnabled: true,
      preferStrongForVerification: false,
      strongModelKey: "gpt-4o",
      cheapModelKey: "gpt-4o-mini",
      automatedTaskModelKey: "gpt-4o-mini",
    });
    vi.spyOn(factoryModule.LLMProviderFactory, "resolveTaskModelSelection").mockReturnValue({
      providerType: "openai",
      modelId: "gpt-4o-mini",
      modelKey: "gpt-4o-mini",
      llmProfileUsed: "cheap",
      resolvedModelKey: "gpt-4o-mini",
      modelSource: "profile_model",
      warnings: [],
    });
    vi.spyOn(factoryModule.LLMProviderFactory, "createProvider").mockReturnValue({
      type: "openai",
      createMessage: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              category: "updates",
              needsReply: false,
              priorityScore: 12,
              urgencyScore: 4,
              staleFollowup: false,
              cleanupCandidate: false,
              handled: true,
              confidence: 0.94,
              rationale: "Transactional notice with no reply requested.",
              labels: ["transactional", "account"],
            }),
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 30 },
      }),
    } as never);

    try {
      await service.reclassifyThread("gmail-thread:alpha");

      const changedThread = (service as any).normalizeGmailThread(
        "gmail:test@example.com",
        "test@example.com",
        {
          id: "gmail-thread:alpha",
          messages: [
            {
              id: "gmail-thread:alpha-message",
              internalDate: String(now - 90 * 60 * 1000),
              snippet: "Updated plan and timing",
              labelIds: [],
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "Subject", value: "Q2 launch review" },
                  { name: "From", value: "Alex <alex@acme.com>" },
                  { name: "To", value: "Test User <test@example.com>" },
                ],
                body: {
                  data: Buffer.from(
                    "Can you send the revised launch plan by tomorrow? Please also propose two meeting times for the review, and note the updated timeline.",
                  )
                    .toString("base64")
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_")
                    .replace(/=+$/, ""),
                },
              },
            },
          ],
        },
      );

      const classifiedUpsert = (service as any).upsertThread(changedThread);
      expect(classifiedUpsert.shouldClassify).toBe(false);

      const newThread = (service as any).normalizeGmailThread(
        "gmail:test@example.com",
        "test@example.com",
        {
          id: "gmail-thread:beta",
          messages: [
            {
              id: "gmail-thread:beta-message",
              internalDate: String(now),
              snippet: "Need approval on the draft",
              labelIds: [],
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "Subject", value: "Draft approval" },
                  { name: "From", value: "Jordan <jordan@acme.com>" },
                  { name: "To", value: "Test User <test@example.com>" },
                ],
                body: {
                  data: Buffer.from("Can you review and approve the draft?").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
                },
              },
            },
          ],
        },
      );

      const newThreadUpsert = (service as any).upsertThread(newThread);
      expect(newThreadUpsert.shouldClassify).toBe(true);

      const row = db
        .prepare(
          `SELECT classification_state, classification_model_key, classification_prompt_version, category, needs_reply
           FROM mailbox_threads
           WHERE id = ?`,
        )
        .get("gmail-thread:alpha") as {
        classification_state: string;
        classification_model_key: string | null;
        classification_prompt_version: string | null;
        category: string;
        needs_reply: number;
      };

      expect(row.classification_state).toBe("classified");
      expect(row.classification_model_key).toBe("gpt-4o-mini");
      expect(row.classification_prompt_version).toBe("v1");
      expect(row.category).toBe("updates");
      expect(row.needs_reply).toBe(0);
    } finally {
      loadSettingsSpy.mockRestore();
    }
  });

  it("syncs Gmail and Email channel accounts in the same run", async () => {
    const { GoogleWorkspaceSettingsManager } = await import("../../settings/google-workspace-manager");
    const loadSettingsSpy = vi.spyOn(GoogleWorkspaceSettingsManager, "loadSettings").mockReturnValue({
      enabled: true,
      timeoutMs: 20_000,
    } as never);
    const syncGmailSpy = vi.spyOn(service as Any, "syncGmail").mockResolvedValue({
      account: {
        id: "gmail:test@example.com",
        provider: "gmail",
        address: "test@example.com",
        displayName: "Test User",
        status: "connected",
        capabilities: ["threads"],
        lastSyncedAt: now,
      },
      syncedThreads: 2,
      syncedMessages: 4,
    });
    const hasEmailChannelSpy = vi.spyOn(service as Any, "hasEmailChannel").mockReturnValue(true);
    const syncImapSpy = vi.spyOn(service as Any, "syncImap").mockResolvedValue({
      account: {
        id: "imap:user@msn.com",
        provider: "imap",
        address: "user@msn.com",
        displayName: "MSN Mail",
        status: "connected",
        capabilities: ["send", "mark_read"],
        lastSyncedAt: now,
      },
      syncedThreads: 3,
      syncedMessages: 6,
    });

    try {
      const result = await service.sync(25);
      expect(syncGmailSpy).toHaveBeenCalledWith(25);
      expect(syncImapSpy).toHaveBeenCalledWith(25);
      expect(result.accounts.map((account) => account.id)).toEqual([
        "gmail:test@example.com",
        "imap:user@msn.com",
      ]);
      expect(result.syncedThreads).toBe(5);
      expect(result.syncedMessages).toBe(10);
    } finally {
      syncImapSpy.mockRestore();
      hasEmailChannelSpy.mockRestore();
      syncGmailSpy.mockRestore();
      loadSettingsSpy.mockRestore();
    }
  });

  it("creates a Mission Control issue from a mailbox thread and deduplicates active handoffs", async () => {
    const company = core.getDefaultCompany();
    const operator =
      agentRoleRepo.findByCompanyId(company.id, false).find((role) =>
        /customer ops|founder office|growth|planner/i.test(role.displayName),
      ) || agentRoleRepo.findByCompanyId(company.id, false)[0];

    expect(operator).toBeTruthy();

    const preview = await service.previewMissionControlHandoff("gmail-thread:alpha");
    expect(preview?.threadId).toBe("gmail-thread:alpha");
    expect(preview?.companyCandidates.length).toBeGreaterThan(0);
    expect(preview?.operatorRecommendations.length).toBeGreaterThan(0);

    const first = await service.createMissionControlHandoff({
      threadId: "gmail-thread:alpha",
      companyId: company.id,
      operatorRoleId: operator!.id,
      issueTitle: preview?.issueTitle || "Inbox handoff",
      issueSummary: preview?.issueSummary,
    });

    expect(first.issueId).toBeTruthy();
    expect(first.companyId).toBe(company.id);
    expect(first.operatorRoleId).toBe(operator!.id);
    expect(first.issueStatus).toBe("open");

    const createdIssue = core.getIssue(first.issueId);
    expect(createdIssue?.metadata?.source).toBe("mailbox_handoff");
    expect(createdIssue?.assigneeAgentRoleId).toBe(operator!.id);
    expect(createdIssue?.metadata?.plannerManaged).toBe(false);
    expect(createdIssue?.metadata?.outputContract).toBeTruthy();

    const second = await service.createMissionControlHandoff({
      threadId: "gmail-thread:alpha",
      companyId: company.id,
      operatorRoleId: operator!.id,
      issueTitle: preview?.issueTitle || "Inbox handoff",
      issueSummary: preview?.issueSummary,
    });

    expect(second.id).toBe(first.id);

    const handoffs = service.listMissionControlHandoffs("gmail-thread:alpha");
    expect(handoffs).toHaveLength(1);
  });

  it("keeps Slack name-only matches as suggestions and merges WhatsApp exact phone matches into the timeline", async () => {
    db.prepare(
      `INSERT INTO mailbox_contacts
        (id, account_id, email, name, company, role, crm_links_json, learned_facts_json, response_tendency, last_interaction_at, open_commitments, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail:test@example.com",
      "alex@acme.com",
      "Alex",
      "Acme",
      "Ops",
      JSON.stringify([]),
      JSON.stringify(["Phone: +351 912 345 678"]),
      "Usually replies within 3.5 hours",
      now,
      0,
      now,
      now,
    );

    const slackChannelId = randomUUID();
    const whatsappChannelId = randomUUID();
    const slackUserDbId = randomUUID();
    const whatsappUserDbId = randomUUID();

    db.prepare(
      `INSERT INTO channels
        (id, type, name, enabled, config, security_config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      slackChannelId,
      "slack",
      "Slack",
      1,
      JSON.stringify({}),
      JSON.stringify({ mode: "pairing" }),
      "connected",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO channels
        (id, type, name, enabled, config, security_config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      whatsappChannelId,
      "whatsapp",
      "WhatsApp",
      1,
      JSON.stringify({}),
      JSON.stringify({ mode: "pairing" }),
      "connected",
      now,
      now,
    );

    db.prepare(
      `INSERT INTO channel_users
        (id, channel_id, channel_user_id, display_name, username, allowed, pairing_attempts, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(slackUserDbId, slackChannelId, "U123", "Alex", "alex", 1, 0, now, now);
    db.prepare(
      `INSERT INTO channel_users
        (id, channel_id, channel_user_id, display_name, username, allowed, pairing_attempts, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      whatsappUserDbId,
      whatsappChannelId,
      "351912345678",
      "Alex",
      null,
      1,
      0,
      now,
      now,
    );

    db.prepare(
      `INSERT INTO channel_messages
        (id, channel_id, session_id, channel_message_id, chat_id, user_id, direction, content, attachments, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      slackChannelId,
      null,
      "slack-1",
      "D123",
      slackUserDbId,
      "incoming",
      "Can you share the revised launch plan in Slack too?",
      null,
      now - 55 * 60 * 1000,
    );
    db.prepare(
      `INSERT INTO channel_messages
        (id, channel_id, session_id, channel_message_id, chat_id, user_id, direction, content, attachments, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      slackChannelId,
      null,
      "slack-2",
      "D123",
      null,
      "outgoing",
      "I will send it shortly.",
      null,
      now - 45 * 60 * 1000,
    );
    db.prepare(
      `INSERT INTO channel_messages
        (id, channel_id, session_id, channel_message_id, chat_id, user_id, direction, content, attachments, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      whatsappChannelId,
      null,
      "wa-1",
      "351912345678",
      whatsappUserDbId,
      "incoming",
      "Ping me here if you need anything before the review.",
      null,
      now - 30 * 60 * 1000,
    );
    db.prepare(
      `INSERT INTO channel_messages
        (id, channel_id, session_id, channel_message_id, chat_id, user_id, direction, content, attachments, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      whatsappChannelId,
      null,
      "wa-2",
      "351912345678",
      null,
      "outgoing",
      "Will do. I will send the final version tonight.",
      null,
      now - 20 * 60 * 1000,
    );

    const resolution = await service.resolveContactIdentity("gmail-thread:alpha");
    expect(resolution?.identity?.id).toBeTruthy();
    expect(
      resolution?.candidates.some(
        (candidate) => candidate.channelType === "slack" && candidate.status === "suggested",
      ),
    ).toBe(true);

    const research = await service.researchContact("gmail-thread:alpha");
    expect(research?.linkedChannels?.some((channel) => channel.channelType === "whatsapp")).toBe(true);
    expect(research?.linkedChannels?.some((channel) => channel.channelType === "slack")).toBe(false);
    expect(research?.unifiedTimeline?.some((event) => event.source === "whatsapp")).toBe(true);

    const slackCandidate = resolution?.candidates.find((candidate) => candidate.channelType === "slack");
    expect(slackCandidate).toBeTruthy();
    await service.confirmIdentityLink(slackCandidate!.id);

    const timeline = await service.getRelationshipTimeline({
      contactIdentityId: resolution?.identity?.id,
      limit: 20,
    });
    expect(timeline.some((event) => event.source === "slack")).toBe(true);

    const identity = service.getContactIdentity(resolution?.identity?.id || "");
    const slackHandle = identity?.handles.find((handle) => handle.channelType === "slack");
    expect(slackHandle).toBeTruthy();
    expect(service.unlinkIdentityHandle(slackHandle!.id)).toBe(true);

    const signalChannelId = randomUUID();
    const signalUserDbId = randomUUID();
    db.prepare(
      `INSERT INTO channels
        (id, type, name, enabled, config, security_config, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      signalChannelId,
      "signal",
      "Signal",
      1,
      JSON.stringify({}),
      JSON.stringify({ mode: "pairing" }),
      "connected",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO channel_users
        (id, channel_id, channel_user_id, display_name, username, allowed, pairing_attempts, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(signalUserDbId, signalChannelId, "signal:+351912345678", "Alex", null, 1, 0, now, now);
    db.prepare(
      `INSERT INTO channel_sessions
        (id, channel_id, chat_id, user_id, workspace_id, state, context, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      signalChannelId,
      "signal-chat-1",
      signalUserDbId,
      identity?.workspaceId || null,
      "idle",
      null,
      now,
      now,
    );
    const linkedSignalHandle = service.linkIdentityHandle({
      workspaceId: identity?.workspaceId || "workspace-a",
      contactIdentityId: resolution?.identity?.id || "",
      handleType: "signal_e164",
      normalizedValue: "+351912345678",
      displayValue: "Alex Signal",
      source: "manual",
      channelId: signalChannelId,
      channelType: "signal",
      channelUserId: "signal:+351912345678",
    });
    expect(linkedSignalHandle).toBeTruthy();

    const replyTargets = service.getReplyTargets(resolution?.identity?.id || "");
    expect(replyTargets.some((target) => target.channelType === "signal")).toBe(true);
    expect(replyTargets.find((target) => target.channelType === "signal")?.chatId).toBe("signal-chat-1");

    const afterUnlink = await service.getRelationshipTimeline({
      contactIdentityId: resolution?.identity?.id,
      limit: 20,
    });
    expect(afterUnlink.some((event) => event.source === "slack")).toBe(false);
  });

  it("drops unknown thread ids when creating a saved view", async () => {
    const workspaceId = "workspace-saved-view-ids";
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "Main",
      "/tmp/ws-saved-view-ids",
      now,
      now,
      JSON.stringify({ read: true, write: true, delete: false, network: true, shell: false }),
    );

    const view = await service.createMailboxSavedView({
      name: "Bucket",
      instructions: "Test bucket",
      seedThreadId: "gmail-thread:alpha",
      threadIds: ["gmail-thread:alpha", "definitely-not-a-real-thread-id"],
    });

    const rows = db
      .prepare(`SELECT thread_id FROM mailbox_saved_view_threads WHERE view_id = ? ORDER BY thread_id`)
      .all(view.id) as { thread_id: string }[];
    expect(rows.map((r) => r.thread_id)).toEqual(["gmail-thread:alpha"]);
  });

  it("keeps saved view thread membership scoped to the seed thread account", async () => {
    const workspaceId = "workspace-saved-view-account-scope";
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "Main",
      "/tmp/ws-saved-view-account-scope",
      now,
      now,
      JSON.stringify({ read: true, write: true, delete: false, network: true, shell: false }),
    );

    db.prepare(
      `INSERT INTO mailbox_accounts
        (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail:other@example.com",
      "gmail",
      "other@example.com",
      "Other User",
      "connected",
      JSON.stringify(["threads"]),
      null,
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO mailbox_threads
        (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "gmail-thread:other",
      "gmail:other@example.com",
      "other",
      "gmail",
      "Other account thread",
      "Thread from another mailbox account.",
      JSON.stringify([{ email: "other@example.com", name: "Other" }]),
      JSON.stringify([]),
      "other",
      10,
      10,
      0,
      0,
      0,
      0,
      0,
      1,
      now - 1000,
      now,
      JSON.stringify({}),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO mailbox_messages
        (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "gmail-thread:other",
      "m-other",
      "incoming",
      "Other",
      "other@example.com",
      JSON.stringify([{ email: "test@example.com", name: "Test User" }]),
      JSON.stringify([]),
      JSON.stringify([]),
      "Other account thread",
      "Thread from another mailbox account.",
      "This message belongs to a different mailbox account.",
      now - 1000,
      0,
      JSON.stringify({}),
      now,
      now,
    );

    const view = await service.createMailboxSavedView({
      name: "Bucket",
      instructions: "Test bucket",
      seedThreadId: "gmail-thread:alpha",
      threadIds: ["gmail-thread:alpha", "gmail-thread:other"],
    });

    const rows = db
      .prepare(`SELECT thread_id FROM mailbox_saved_view_threads WHERE view_id = ? ORDER BY thread_id`)
      .all(view.id) as { thread_id: string }[];
    expect(rows.map((r) => r.thread_id)).toEqual(["gmail-thread:alpha"]);
  });

  it("rejects saved views when no valid threads remain after validation", async () => {
    const workspaceId = "workspace-saved-view-empty";
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "Main",
      "/tmp/ws-saved-view-empty",
      now,
      now,
      JSON.stringify({ read: true, write: true, delete: false, network: true, shell: false }),
    );

    await expect(service.createMailboxSavedView({
      name: "Bucket",
      instructions: "Test bucket",
      threadIds: ["not-a-real-thread"],
    })).rejects.toThrow("Saved views need at least one valid thread");
  });

  it("hides threads from the main inbox when a saved view opts out, unless also linked to a show-in-inbox view", async () => {
    const workspaceId = "workspace-sv-inbox-filter";
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "Main",
      "/tmp/ws-sv-inbox-filter",
      now,
      now,
      JSON.stringify({ read: true, write: true, delete: false, network: true, shell: false }),
    );

    const viewHide = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_saved_views (id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(viewHide, workspaceId, "Hidden bucket", "x", "gmail-thread:alpha", now, now);
    db.prepare(`INSERT INTO mailbox_saved_view_threads (view_id, thread_id, score) VALUES (?, ?, 1)`).run(
      viewHide,
      "gmail-thread:alpha",
    );

    const inboxHidden = await service.listThreads({ mailboxView: "inbox" });
    expect(inboxHidden.map((t) => t.id)).not.toContain("gmail-thread:alpha");

    const viewShow = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_saved_views (id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(viewShow, workspaceId, "Visible bucket", "y", null, now, now);
    db.prepare(`INSERT INTO mailbox_saved_view_threads (view_id, thread_id, score) VALUES (?, ?, 1)`).run(
      viewShow,
      "gmail-thread:alpha",
    );

    const inboxShown = await service.listThreads({ mailboxView: "inbox" });
    expect(inboxShown.map((t) => t.id)).toContain("gmail-thread:alpha");
  });

  it("keeps inbox counts aligned with hide-only saved view filtering", async () => {
    const workspaceId = "workspace-sv-counts";
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      "Main",
      "/tmp/ws-sv-counts",
      now,
      now,
      JSON.stringify({ read: true, write: true, delete: false, network: true, shell: false }),
    );

    const hiddenViewId = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_saved_views (id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(hiddenViewId, workspaceId, "Hidden bucket", "x", "gmail-thread:alpha", now, now);
    db.prepare(`INSERT INTO mailbox_saved_view_threads (view_id, thread_id, score) VALUES (?, ?, 1)`).run(
      hiddenViewId,
      "gmail-thread:alpha",
    );

    const syncHidden = await service.getSyncStatus();
    const digestHidden = await service.getMailboxDigest(workspaceId);
    expect(syncHidden.threadCount).toBe(0);
    expect(syncHidden.unreadCount).toBe(0);
    expect(digestHidden.threadCount).toBe(0);
    expect(digestHidden.unreadCount).toBe(0);

    const visibleViewId = randomUUID();
    db.prepare(
      `INSERT INTO mailbox_saved_views (id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(visibleViewId, workspaceId, "Visible bucket", "y", null, now, now);
    db.prepare(`INSERT INTO mailbox_saved_view_threads (view_id, thread_id, score) VALUES (?, ?, 1)`).run(
      visibleViewId,
      "gmail-thread:alpha",
    );

    const syncShown = await service.getSyncStatus();
    const digestShown = await service.getMailboxDigest(workspaceId);
    expect(syncShown.threadCount).toBe(1);
    expect(syncShown.unreadCount).toBe(1);
    expect(digestShown.threadCount).toBe(1);
    expect(digestShown.unreadCount).toBe(1);
  });
});
