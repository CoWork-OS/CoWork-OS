# Composer predictions

After a task completes, the empty message composer can suggest a complete next message based on the current conversation. Predictions are enabled by default; toggle **Settings → Appearance → Composer → Enable composer predictions** to turn them on or off.

When the first usable prediction appears, the left sidebar shows **New: Composer predictions** with a one-time tooltip explaining acceptance and the setting. **Open settings** goes directly to Appearance. Close the tooltip with **Got it**, Escape, or an outside click; dismiss the notice with its X to hide it permanently. Availability, seen state, and dismissal persist locally across reloads.

- Press **Tab** to accept, then edit or send normally. Accepting never sends a message.
- Press **Escape** to dismiss, or start typing your own message. A dismissed prediction stays dismissed for that response while the composer remains mounted.
- Predictions do not replace drafts, attachments, quoted replies, or voice input, and are hidden while tasks or child agents are working or during replay.
- A prediction may be skipped. Provider failures do not block the composer.

## Selected LLM and token usage

**Generating predictions uses your selected LLM provider and consumes input and output tokens, even if you never accept or send the suggestion.** The recent conversation is sent as input; the suggested message is generated as output. Your provider's usual billing, account limits, or local inference costs apply.

Predictions follow the conversation's selected provider, or the current provider in AI settings when the conversation has no provider override. When profile routing is enabled, generation uses that provider's configured **Cheap** model profile. Otherwise, it uses the provider's selected default model. A separate model picked for the main conversation does not override the prediction's Cheap profile. See [Model Providers](providers.md) for model access and routing configuration.

Turn off **Enable composer predictions** to prevent new prediction requests and cancel pending generation. Tokens already consumed before cancellation may still count toward usage. Reusing a cached prediction does not make another model request. Accepting a suggestion only fills the draft; sending that draft starts a normal follow-up with its own model usage.

## Context and request lifecycle

Generation uses a bounded recent conversation excerpt and the initial task prompt. It does not retrieve memories, search connected apps, expose tools, or execute tasks. Suggestions are temporary until accepted; accepted text uses the existing composer draft persistence.

The desktop IPC endpoint reads context from the task database, validates the response revision before queued work starts and after generation, and deduplicates requests with a bounded in-process cache. Only successful predictions are cached, for five minutes; failed or empty requests can retry when the composer becomes eligible again or the chat is reopened. Cache keys include the resolved provider and model.

Generation runs one provider call at a time with at most eight queued jobs. Editing, disabling predictions, switching chats, or destroying the renderer cancels its queued work and aborts its in-flight request. Shared generation continues only while another subscriber still needs it. An aborted provider retains the concurrency slot until it settles. The request has a 15-second abort signal and a small output budget. Browser hosts without the prediction API skip the feature.

Focused checks:

```sh
npx vitest run src/electron/agent/__tests__/composer-prediction*.test.ts src/renderer/hooks/__tests__/composer-predictions.test.ts src/renderer/components/__tests__/composer-styles.test.ts src/renderer/components/sidebar/__tests__/sidebar-notices.test.tsx
npm run type-check
npm run build:electron
npm run build:react
```
