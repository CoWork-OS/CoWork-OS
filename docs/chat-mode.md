# Chat Mode

Chat mode is the direct conversational path in CoWork OS.

It is intentionally different from task execution modes:

- **No tools by default**
- **No step timeline**
- **No verification / success / partial-success labels**
- **Same-session follow-ups** stay in the current conversation
- **Explicit only**: chat mode is used only when `executionMode` is set to `"chat"`

Selecting an access profile for the surrounding task does not turn tools on in Chat mode. Chat
remains a no-tools conversation, while an execution task uses its [access profile](access-profiles.md)
to determine sandbox, command-tool, filesystem, network, and approval behavior. The uploaded-PDF
exception remains read-only.

There is one narrow exception: if a chat turn includes uploaded PDF attachment metadata and the user asks for content that goes beyond the compact excerpt, CoWork promotes that turn to read-only analysis mode so the document parser can read the attached PDF. This does not enable mutating tools.

Side Chat also uses chat execution mode internally, but it is a separate right-side session type with a parent-task boundary. See [Side Chat](side-chat.md).

## Behavior

- The user prompt is sent directly to the LLM as a chat request.
- Follow-up questions keep the earlier conversation in the same session.
- Long conversations use a summary-plus-recent-window history strategy so older context is preserved without sending the full transcript every turn.
- The chat summary is cached and persisted in the conversation snapshot, so it does not need to be regenerated on every turn.
- Explicit chat requests use a fixed high output budget, capped at **48K tokens**, so the same cap applies to the first answer and follow-ups.
- Uploaded PDF turns that need deeper content are routed through the normal read-only document parser path. The initial chat prompt still carries only a compact PDF excerpt plus the workspace-relative path; `parse_document` reads the file when needed.

## Streaming

- Azure chat calls stream incrementally in chat mode.
- Other modes keep their existing execution behavior and do not use this chat-only streaming path.

## When To Use It

Use chat mode when you want a normal assistant conversation:

- ask a question
- ask a follow-up
- keep the same context
- get a direct answer without task planning or tool use

If you want CoWork OS to execute work, create artifacts, or use tools, use one of the task modes instead.

If you attach a PDF and ask CoWork to summarize it, answer questions from it, extract clauses, compare sections, or transform it into another format, CoWork may leave direct chat for that turn and use read-only analysis so it can inspect the full document safely.

## Side Chat Relationship

Side Chat is built on the same no-tools chat path, but it is not a normal chat session.

Side Chat is for asking about an active parent task while that task keeps running. It opens from `/side`, appears in the right panel, hides inherited parent transcript events from the visible side transcript, and injects fresh parent-status context for progress questions.

Normal chat mode is for direct conversation. Side Chat is for read-only inspection of another running session. Side questions must not steer, approve, cancel, or mutate the parent task.
