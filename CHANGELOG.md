# Changelog

## 0.11.1 — 2026-11-27

- Updated Smart Turn and watermark documentation for application developers.

## 0.11.0 — 2026-11-27

- Conversation summaries no longer delay answers. A summary starts in the background after a reply and never holds up a turn: answers use the full conversation until it is ready. Before, once the conversation passed `maxContextTokens` every turn waited for a summary request before its answer request started.
- `maxContextTokens` counts the conversation (its turns plus the current summary), not the instructions. Before, instructions longer than the budget (5,000 estimated tokens by default) made every turn from the third one on summarize.
- A new summary covers the previous one and replaces it, instead of being appended to it. Turns added while a summary is written are kept, and every turn not yet summarized is sent to the model; before, only the four most recent turns were sent once a summary existed. Summaries are requested as plain text, so providers with structured output (`responseFormat`) summarize too.
- One summary runs at a time, with its own cancellation: `stop()` cancels it, `ContextManager.reset()` discards its result. A failed or empty summary (including a provider error such as a truncated reply) is logged as a warning and leaves the conversation as it was; it is no longer reported as a turn error. `ContextManager.summarize()` now resolves `true` when it committed a summary. `prepareMs` / `Prepare` no longer include summarization.
- `OpenRouterLLM` and `OpenAILLM` warmup asks for at most 16 output tokens instead of a full reply: it only primes the connection and the provider's prompt cache. `LLMChatOptions.maxTokens` sets a per-request output limit.
- dTelecom Cloud TTS: the character hold is extended in the background once fewer than `extendWhenCharactersLeft` characters remain, so a sentence no longer waits for the extension request. Only a sentence that would pass the hold itself waits; if that extension fails, the sentence fails as before. A failed background extension is logged and retried after 15 s or when a sentence needs it.
- `DtelecomSTT` streams have `finalize()`: it asks the server to end the current utterance now and send its final transcript. It is sent only when the server's ready message advertises `finalize: true` (reported as `ready.finalize` / `stt_ready.finalize`); with other servers it does nothing and returns `false`. The pipeline does not call it yet. `STTStream.finalize` is an optional method of the interface.

## 0.10.0 — 2026-11-26

- Voice agents can connect to the next node when the primary is unavailable. Cloud supplies the ranked signaling URLs. For a pre-signed token, pass the issuer's `fallbackUrls` alongside `wsUrl`.
- When Cloud extends a session, the agent uses the renewed token for reconnects. This release requires `@dtelecom/server-sdk-node` 0.4.0 or later and `@dtelecom/server-sdk-js` 4.4.0 or later.

## 0.9.1 — 2026-11-24

- Speech no longer breaks numbers apart. A sentence now ends at `.`, `!`, `?` or `؟` followed by a space (or at 。！？।, which need none), so decimals, versions and domains such as `$0.004`, `4.2.1` and `docs.dtelecom.org` reach TTS whole, whatever the token boundaries. Before, a reply streamed as "costs $0." + "004 per minute" was spoken as two sentences. A period after common abbreviations (e.g., i.e., Dr.) does not end a sentence.
- A short first sentence such as "Hi!" no longer holds back the rest of the reply: it joins the next sentence and is spoken as soon as that one is complete, instead of waiting for 250 characters or the end of the reply.

## 0.9.0 — 2026-11-24

- Tool results: a tool with a `handler` (`{ definition, handler, timeoutMs? }`) is run by the agent; its result goes back to the model as a `tool` message and the agent speaks the answer. Errors, invalid arguments and timeouts (default 30 s) go back as `{"error": ...}`; barge-in aborts the handler. At most three tool rounds per turn, then the model is asked to answer with `tool_choice: "none"`. The call and its result are kept together in the context. A bare `ToolDefinition` behaves as before (emit `toolCall`, end the turn).
- `Message` is now the OpenAI chat union: assistant messages can carry `tool_calls` (with `content: null`), and `role: 'tool'` messages carry `tool_call_id`. `LLMChatOptions.toolChoice` is sent as `tool_choice` by both LLM providers when tools are passed.
- New `metrics` event per completed turn (`TurnMetrics`): the latency already logged as `LATENCY`, in milliseconds, plus `toolMs` and `toolCalls`.

## 0.8.2 — 2026-11-23

- Docs only: the README links [docs.dtelecom.org](https://docs.dtelecom.org) and starts with the dTelecom Cloud quick start. Code is the same as 0.8.1.

## 0.8.1 — 2026-11-17

- Docs only: `DtelecomTTSOptions.defaultLanguage` defaults to the first language in `voices`; its comment said `"en"`.

## 0.8.0 — 2026-11-16

- The agent keeps its room: in cloud mode it extends its own WebRTC token by `ttl` before the token expires (10 minutes before, or at half its life for short tokens), since dTelecom Cloud now removes a participant a minute after an unextended token expires. A failed extension surfaces as an `error` event; a refused payment is retried every 15 s until the token's grace ends; `session_not_extendable` is reported once.
- A speech session key serves one connection. After a disconnect, `DtelecomSTT` and `DtelecomTTS` in cloud mode open a new session (STT in its current language, with backoff from 1 s to 30 s) instead of reusing the key. In x402 mode pass `getSessionKey` to supply a new key; without it a lost connection is reported as an `error` instead of reconnecting with the used key.
- Speech streams connect to the cloud's `stream_url` when it is given (`@dtelecom/server-sdk-js` 4.2), else to `serverUrl` + `/v1/stream`. TTS now accepts a server URL that already ends in `/v1/stream`.
- STT keeps at most 5 s of audio while it connects; the oldest is dropped first.
- Requires Node.js 22 or later, as `@dtelecom/server-sdk-node` 0.3 does (werift 0.27). Peer dependency `@dtelecom/server-sdk-node` is now `>=0.3.0`: 0.2.x runs a postinstall that fails in a fresh project.
- README: the events table lists `agentState`, `sentence` and `toolCall`; `speaking` was never emitted. Examples import `@dtelecom/agents-js`.

## 0.7.0 — 2026-11-10

- Add dTelecom Cloud mode. `agent.start({ cloud })` mints the agent's WebRTC token through a `CloudClient`; `{ apiKey, apiSecret }` now builds one from `DTELECOM_CLOUD_URL` instead of signing locally, which `@dtelecom/server-sdk-js` 4.0 removed. Optional `ttl` sets the agent's session lifetime.
- `DtelecomSTT({ cloud })` opens one STT session per participant stream and `DtelecomTTS({ cloud })` one TTS session, both linked to the agent's room session. Sessions hold small chunks (10 minutes; 2,000 characters), are extended before they run out with `{ type: "extend", session_key }` on the open socket, and reconnects use the latest key. `cloudSession` changes the chunk sizes.
- Peer dependency `@dtelecom/server-sdk-js` is now `>=4.1.0`. The x402 modes (`token` + `wsUrl`, `serverUrl` + `sessionKey`) are unchanged.

## 0.6.2 — 2026-10-27

- Publish corrected gateway pricing and the 367-character voice-agent usage example in the npm README. Documentation-only release; runtime behavior is unchanged.

## 0.6.1 — 2026-10-23

- Correct the 48 kHz TTS diagram, gateway provider example, partial events, current Smart Turn guidance and public SSML documentation links.

## 0.6.0 — 2026-10-23

- Add explicit `DtelecomTTS({ watermark: true })` opt-in for AudioSeal B, with capability negotiation and activation confirmation before yielding PCM. Plain text and complete-request SSML are supported; defaults stay unmarked.

## 0.5.0 — 2026-10-22

- Add complete-request SSML synthesis with capability negotiation and VoiceAgent.saySSML; preserve existing plain speech and language routing.
- Add explicit OpenRouter reasoning effort, optional temperature omission and required-provider-parameter controls for compatible models.
- Retain partial transcript lifecycle, cancellation and queue timing improvements from 0.4.1.

## 0.4.1 — 2026-10-22

- Create the response cancellation signal before warmup and summarization; pass it through summary generation and discard cancelled summaries without changing conversation history.
- Cancel warmup/memory waits and greetings safely, and prevent pending responses from starting after shutdown.
- Wait for both LLM and audio task cleanup before starting the latest pending turn. Wake an idle audio consumer when generation fails or is cancelled.
- Recognize `APIUserAbortError` as expected cancellation only when the response signal was aborted; keep genuine provider failures visible.
- Store timing with each pending turn and report `Queue` and `Prepare` separately from LLM generation. `Overall` still excludes STT endpointing wait; turns without a text response report it as unavailable.

## 0.4.0 — 2026-10-22

- Add independent `partials` and `smartTurn` opt-ins to DtelecomSTT; preserve final-only defaults.
- Surface provisional windows, revisions, utterance IDs, partial-end lifecycle and explicit Smart Turn activation/fallback through stream, pipeline and agent events.
- Keep partials out of LLM turn creation while allowing existing barge-in behavior.
- Preserve feature flags across language changes/reconnects and accept already-normalized `/v1/stream` URLs.
- Add STT event overloads to public types. Custom STT streams with a manually narrowed `on` method should extend `BaseSTTStream` or accept the new optional event names; they do not need to emit them.
- Retain 0.3.9 Unicode speech filtering and 0.3.8 cancellation fixes.
