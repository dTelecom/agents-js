# Changelog

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
