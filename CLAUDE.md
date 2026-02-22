# CLAUDE.md — @dtelecom/agents-js

## Rules

**Don't commit/push/publish unless asked** — Never commit, push, or npm publish unless the user explicitly asks. A single request does NOT authorize future operations — each commit/push/publish needs its own explicit request. When the user reports a build error, fix it locally and propose the fix — do NOT auto-commit and push.

**Read project docs first** — Always read this file and any relevant project docs before making changes.

**Don't guess fixes** — Research the proper solution first (read docs, check how other projects solve it, understand root cause). Never try more than one approach without stopping to present findings to the user. If the first attempt fails, STOP and explain what you learned before trying again.

**Plan before fixing** — If something is broken, provide a plan first and verify the approach with the user before implementing. This applies to ALL fixes — not just code bugs.

**Test before declaring done** — Run `npm run build` and `npm test` to verify changes compile and pass tests before saying it's done.

## Project Overview

`@dtelecom/agents-js` — AI voice agent framework for dTelecom rooms. TypeScript SDK that lets developers create AI voice agents joining dTelecom rooms via WebRTC.

## Architecture

```
Speech → SFU → server-sdk-node (Opus decode) → PCM16 16kHz
  → STT (Deepgram) → transcription
  → LLM (OpenRouter) → text response (with sentence splitting)
  → TTS (Cartesia or Deepgram) → PCM16 48kHz
  → AudioSource (Opus encode) → SFU → participants
```

Pipeline uses producer/consumer pattern: LLM tokens → sentence splitter → sentence queue → TTS → audio output. Both run concurrently so playback never blocks LLM consumption.

## Key Dependencies

| Package | Role |
|---|---|
| `@dtelecom/server-sdk-node` | Node.js WebRTC (werift + @discordjs/opus). Room, AudioStream, AudioSource |
| `@dtelecom/server-sdk-js` | AccessToken (Ed25519 JWT), getWsUrl() SFU discovery |
| `ws` | WebSocket client for STT/TTS providers |

## Project Structure

```
src/
  core/           # Pipeline, VoiceAgent, ContextManager, SentenceSplitter, TurnDetector, BargeIn
  providers/      # DeepgramSTT, OpenRouterLLM, CartesiaTTS, DeepgramTTS
  room/           # RoomConnection, AudioInput, AudioOutput
  memory/         # RoomMemory, MemoryStore, Embedder (optional, separate entry point)
  utils/          # Logger
```

Entry points: `src/index.ts` (core), `src/providers/index.ts`, `src/memory/index.ts`

## Provider Protocols

### DeepgramSTT
- WebSocket: `wss://api.deepgram.com/v1/listen?model=nova-3&...`
- Auth: `Authorization: Token <key>` header
- Send binary PCM16 16kHz, receive JSON transcriptions

### DeepgramTTS (Aura-2)
- WebSocket: `wss://api.deepgram.com/v1/speak?model={model}&encoding=linear16&sample_rate=48000`
- Auth: `Authorization: Token <key>` header
- Send: `{"type":"Speak","text":"..."}` then `{"type":"Flush"}`
- Receive: binary frames (raw PCM16) until `{"type":"Flushed"}` JSON
- Cancel: `{"type":"Clear"}` then `{"type":"Flush"}`
- Multi-language: connection pool keyed by language, SSML `<lang>` tags for routing
- Voices are language-locked (one voice = one language)

### CartesiaTTS
- WebSocket: `wss://api.cartesia.ai/tts/websocket?api_key=...`
- Multiplexed via `context_id`, base64 PCM16 chunks, `{"type":"done"}` completion

### OpenRouterLLM
- REST SSE: `POST https://openrouter.ai/api/v1/chat/completions` with `stream: true`

## Related Projects

- **ai-tutor-demo**: `/Users/vf/docs/ai-tutor-demo/` — separate git repo, uses this SDK
- Uses `--legacy-peer-deps` due to sqlite-vec alpha version conflict

## Build & Test

```bash
npm run build          # tsup → dist/ (CJS + ESM + DTS)
npm test               # vitest
npm run lint           # tsc --noEmit
```

## Env Vars

```
DTELECOM_API_KEY       # dTelecom API key
DTELECOM_API_SECRET    # dTelecom API secret
DEEPGRAM_API_KEY       # Deepgram (STT + TTS)
OPENROUTER_API_KEY     # OpenRouter (LLM)
CARTESIA_API_KEY       # Cartesia TTS (optional, if using Cartesia)
```
