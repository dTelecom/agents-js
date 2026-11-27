# @dtelecom/agents-js

AI voice agent framework for [dTelecom](https://dtelecom.org) rooms. Build real-time voice agents that join WebRTC rooms and interact with participants using speech-to-text, LLMs, and text-to-speech.

**Documentation:** [docs.dtelecom.org](https://docs.dtelecom.org), see the [agents SDK reference](https://docs.dtelecom.org/reference/agents-sdk/) and the [voice agent guide](https://docs.dtelecom.org/guides/voice-agent/).

## Architecture

```
Participant mic -> SFU -> server-sdk-node (Opus decode) -> PCM16 16kHz
  -> STT plugin -> transcription
  -> LLM plugin -> streaming text response
  -> Sentence splitter -> TTS plugin -> PCM16 48kHz
  -> AudioSource (48kHz Opus encode) -> SFU -> Participants
```

The pipeline uses a producer/consumer pattern: LLM tokens are split into sentences and queued, while a consumer synthesizes and plays audio concurrently. This minimizes time-to-first-audio.

After completed speech, the pipeline retains an 800 ms estimate for audio to reach the listener before changing its UI state to idle. This wait is cancellable: a new user turn releases it immediately, and an interrupted response or greeting does not add the wait after provider cleanup. Responses with no speech audio skip it entirely. Cancellation still flushes local buffered audio and waits for the active producer/consumer to finish before starting the queued turn; TTS synthesis remains sequential for providers that require it.

Cancellation covers warmup, memory lookup and response generation. A final transcript arriving during a response occupies a single pending-turn slot (the latest final replaces any earlier pending final) and interrupts the current cycle. The next cycle starts after the active provider tasks finish cancellation cleanup. An `APIUserAbortError` from an aborted cycle is expected cancellation; genuine provider failures remain errors.

When the conversation (its turns plus the current summary, not the instructions) passes `maxContextTokens`, older turns are summarized in the background after a reply, keeping the four most recent verbatim. No answer waits for a summary: answers use the full conversation until the summary is ready. The new summary covers the previous one and replaces it; turns spoken while it is written are kept. One summary runs at a time. A failed summary is logged and the conversation stays as it is; `stop()` cancels a running summary and a context reset discards it.

Latency logs separate `Queue` (final transcript received to response-cycle start), `Prepare` (warmup and memory lookup), `LLM` (request to first sentence, including `TTFT`) and `TTS` (first sentence to first audio). `STT` is server-reported processing time. `Overall` includes those phases but excludes STT endpointing wait; it is unavailable for turns without a text response. These measurements are not microphone-to-speaker latency.

For dTelecom TTS, cancellation sends `clear` and waits for `cleared` before reusing the WebSocket. Late audio from the cancelled request is discarded. A missing acknowledgement closes the connection after five seconds so a subsequent request reconnects; this is an error timeout, not a delay applied to successful cancellations.

## Install

```bash
npm install @dtelecom/agents-js @dtelecom/server-sdk-js @dtelecom/server-sdk-node
```

Requires Node.js 22 or later.

## Quick start with dTelecom Cloud

You need a dTelecom Cloud project with balance for WebRTC, STT and TTS, and a separate OpenRouter API key for the language model. In the directory where you installed the packages above, create a backend-only `.env` file and fill in your keys.

```dotenv
DTELECOM_CLOUD_URL=https://cloud.dtelecom.org
DTELECOM_API_KEY=
DTELECOM_API_SECRET=
OPENROUTER_API_KEY=
```

Save the following as `agent.mjs`. The agent and both speech providers share one Cloud client. The agent obtains its own room token and the speech sessions are linked to it.

```js
import { CloudClient } from '@dtelecom/server-sdk-js';
import { VoiceAgent } from '@dtelecom/agents-js';
import { DtelecomSTT, DtelecomTTS, OpenRouterLLM } from '@dtelecom/agents-js/providers';

async function main() {
  const cloud = new CloudClient();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY for the language model');

  const agent = new VoiceAgent({
    stt: new DtelecomSTT({ cloud, language: 'en', partials: true, smartTurn: true }),
    llm: new OpenRouterLLM({ apiKey, model: 'openai/gpt-4o-mini', maxTokens: 120 }),
    tts: new DtelecomTTS({ cloud, voices: { en: { voice: 'af_heart', langCode: 'a' } } }),
    instructions: 'Answer in one or two short sentences.',
    respondMode: 'always',
  });
  agent.on('transcription', ({ text, isFinal }) => {
    if (isFinal) console.log('Heard:', text);
  });
  agent.on('response', (text) => console.log('Assistant:', text));
  agent.on('error', (error) => console.error('Agent error:', error.message));

  const room = process.env.ROOM_NAME || 'voice-demo';
  await agent.start({ room, identity: 'assistant', cloud, ttl: '10m' });
  console.log(`Listening in ${room}. Press Ctrl+C to disconnect.`);
  process.once('SIGINT', async () => {
    await agent.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
```

Run `node --env-file=.env agent.mjs`. Join `voice-demo` from a browser in the same Cloud project using a different participant identity. Enable the microphone and audio playback, then ask a question. The terminal shows the final transcript and reply, and the browser plays the answer. Press Ctrl+C to stop the agent. [Browser quickstart](https://docs.dtelecom.org/quickstart/) · [Runnable source](examples/basic-agent.ts)

How the sessions work:

- **STT**: one session per participant stream, billed per connected minute. Each holds 10 minutes of balance and is extended by 10 minutes when under 2 remain. Change it with `cloudSession: { minutes, extendWhenMinutesLeft }`.
- **TTS**: one session for the agent's voice, billed per character. It holds 2,000 characters and is extended in the background once fewer than 500 remain, so sentences do not wait for it; only a sentence that would pass the hold waits for the extension. It is also extended before its 30-minute window closes. Change it with `cloudSession: { characters, extendWhenCharactersLeft }`.
- Unused holds are released when a session ends. An extension sends the new key to the open socket. A session key serves one connection: after a disconnect the provider opens a new session. A session the cloud refuses (for example `insufficient_balance`) surfaces as an `error` event.
- `ttl` sets how long the agent's room token holds (default 6 hours, at most 24). The agent extends it by the same amount before it expires, so it stays until `stop()`; the cloud removes a participant a minute after an unextended token expires. A failed extension surfaces as an `error` event.

Rates are in the dashboard's billing catalog: STT $0.004 per connected minute, TTS $0.006 per 1,000 characters, WebRTC audio $0.0001 per participant minute. File transcription, WAV synthesis, translation, vision and moderation are on `CloudClient` itself; VoiceAgent does not call them.

## Other STT and TTS providers

```ts
import { VoiceAgent, setLogLevel } from '@dtelecom/agents-js';
import { DeepgramSTT, OpenRouterLLM, CartesiaTTS } from '@dtelecom/agents-js/providers';

const agent = new VoiceAgent({
  stt: new DeepgramSTT({ apiKey: process.env.DEEPGRAM_API_KEY! }),
  llm: new OpenRouterLLM({
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: 'openai/gpt-4o',
  }),
  tts: new CartesiaTTS({
    apiKey: process.env.CARTESIA_API_KEY!,
    voiceId: 'your-voice-id',
  }),
  instructions: 'You are a helpful voice assistant.',
});

await agent.start({
  room: 'my-room',
  apiKey: process.env.DTELECOM_API_KEY!,
  apiSecret: process.env.DTELECOM_API_SECRET!,
});
```

`apiKey` and `apiSecret` are a dTelecom Cloud project's API key; the agent's token comes from the cloud at `DTELECOM_CLOUD_URL`. Pass `cloud` instead to reuse a client (see above).

## dTelecom gateway speech (x402)

Create a prepaid bundle with `DtelecomGateway` from `@dtelecom/x402-client`, then pass its tokens to the providers. This example assumes `gateway` is configured with a funded wallet and `llm` implements the LLM plugin interface:

```ts
import { VoiceAgent } from '@dtelecom/agents-js';
import { DtelecomSTT, DtelecomTTS } from '@dtelecom/agents-js/providers';

const session = await gateway.createAgentSession({
  roomName: 'voice-demo', participantIdentity: 'assistant',
  clientIdentity: 'listener', durationMinutes: 5, language: 'en',
});
const agent = new VoiceAgent({
  stt: new DtelecomSTT({
    serverUrl: session.stt.serverUrl, sessionKey: session.stt.token,
    language: 'en', partials: true, smartTurn: true,
  }),
  tts: new DtelecomTTS({
    serverUrl: session.tts.serverUrl, sessionKey: session.tts.token,
    voices: { en: { voice: 'M5', langCode: 'en' }, ru: { voice: 'M5', langCode: 'ru' } },
    speed: 1.1, // application preference; SDK default is 1.0
    // watermark: true, // independent explicit opt-in
  }),
  llm, instructions: 'Be helpful and concise.',
});
await agent.start({ room: 'voice-demo', token: session.webrtc.agent.token, wsUrl: session.webrtc.agent.wsUrl });
```

A gateway session key serves one connection. To let the providers reconnect after a network drop, pass `getSessionKey: async () => ({ sessionKey, serverUrl })`, returning a new key from your gateway session; without it, a lost connection surfaces as an `error` event.

The client joins with `session.webrtc.client`. STT is $0.004/connected session minute; TTS is $0.006/1,000 spoken Unicode code points; WebRTC is $0.0001/audio participant minute. Two participants, one STT session and 367 TTS characters/minute cost approximately $0.0064/minute, excluding LLM charges. [Live pricing and enabled services](https://x402.dtelecom.org/v1/pricing).

This framework runs live voice agents. Translation, file transcription/diarization, WAV jobs, vision and moderation use the separate [x402 client SDK](https://github.com/dTelecom/x402-client); they are not automatically invoked by VoiceAgent.

Cloud mode forwards the issuer’s ranked signaling endpoints and replaces the reconnect credential when the session is extended. With a pre-signed token, pass the optional issuer-provided `fallbackUrls` array alongside `wsUrl`. A single URL is sufficient when the issuer supplies only one node.

## Plugin Interfaces

### STT

```ts
interface STTPlugin {
  createStream(options?: STTStreamOptions): STTStream;
}

interface STTStream {
  sendAudio(pcm16: Buffer): void;
  on(event: 'transcription', cb: (result: TranscriptionResult) => void): this;
  on(event: 'error', cb: (error: Error) => void): this;
  close(): Promise<void>;
}
```

### LLM

```ts
interface LLMPlugin {
  chat(messages: Message[], signal?: AbortSignal): AsyncGenerator<LLMChunk>;
  warmup?(systemPrompt: string): Promise<void>;
}
```

### TTS

```ts
interface TTSPlugin {
  synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer>;
  warmup?(): Promise<void>;
}
```

## dTelecom partial transcripts and Smart Turn

```ts
import { DtelecomSTT } from '@dtelecom/agents-js/providers';

const stt = new DtelecomSTT({
  serverUrl: session.stt.serverUrl,
  sessionKey: session.stt.token,
  language: 'en',
  partials: true,
  smartTurn: true, // independent opt-in; omit for ordinary acoustic endpointing
});
```

Both options are omitted by default, preserving existing final-only behavior. `partials` requests replaceable recognition windows. The provider sends `smartTurn` as `smart_turn`; it requires a supported language and a server offering the feature. These choices survive language changes and reconnects.

With this provider in `VoiceAgent`, subscribe to:

- `transcription_partial`: `{ text, isFinal: false, utteranceId, revision, windowStartSeconds, provisional: true, replacePrevious: true, speaker }`. Replace the displayed provisional window; do not append it to committed text.
- `partial_end`: `{ utteranceId, reason, speaker }`. Clear provisional text on `finalizing`, `discarded`, `replaced` or `reconfigured`.
- `transcription`: partials also appear here with `isFinal: false`; finals carry the same `utteranceId` and supersede them. Only finals start an LLM turn. Nonempty partials can trigger barge-in while the agent is speaking.
- `stt_ready`: `{ clientId?, language?, smartTurn?, finalize?, speaker }`. `smartTurn: "active"` confirms the semantic hook; `"acoustic_fallback"` reports silence detection. An absent field does not confirm activation. Missing server-model errors surface through `error`. `finalize: true` means the server accepts `finalize` (below).

`stream.finalize()` asks the server to end the current utterance now and send its final transcript, instead of waiting for the end-of-speech silence; call it when your application knows the speaker has finished. It is sent only when the connected server advertised `finalize: true` in its ready message; otherwise, and before the stream is ready, it does nothing and returns `false`. Support is reset on every reconnect. The agent's own pipeline does not call it yet.

Raw `STTStream` exposes the same events without `speaker`, with `ready` instead of `stt_ready`. Providers other than dTelecom may not emit these optional event types. For transcript display, subscribe to either `transcription_partial` or nonfinal `transcription`, not both.

Use server-sdk-node 0.2.6 or later to supply silence during Opus DTX or input stalls. See the [Smart Turn integration guide](SMART_TURN.md) to check activation or acoustic fallback for a stream.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `stt` | `STTPlugin` | required | Speech-to-text provider |
| `llm` | `LLMPlugin` | required | Language model provider |
| `tts` | `TTSPlugin` | `undefined` | Text-to-speech provider (text-only if omitted) |
| `instructions` | `string` | required | System prompt for the LLM |
| `respondMode` | `'always' \| 'addressed'` | `'always'` | When to respond to speech |
| `agentName` | `string` | `'assistant'` | Name for addressed-mode detection |
| `nameVariants` | `string[]` | `[]` | Additional names to respond to |
| `onDataMessage` | `DataMessageHandler` | `undefined` | Callback for data channel messages |
| `tools` | `Tool[]` | `undefined` | Tools the model can call; see [Tools](#tools) |
| `maxContextTokens` | `number` | `5000` | Conversation size (turns plus summary, estimated at 4 characters per token; instructions not counted) above which older turns are summarized in the background |

## Events

| Event | Payload | Description |
|---|---|---|
| `transcription` | `{ text, isFinal, speaker, utteranceId? }` | Final or provisional STT result |
| `transcription_partial` | `{ text, utteranceId, revision, windowStartSeconds, speaker }` | Replace temporary display text |
| `partial_end` | `{ utteranceId, reason, speaker }` | Clear temporary display text |
| `stt_ready` | `{ clientId?, language?, smartTurn?, finalize?, speaker }` | Check active/fallback endpointing and `finalize` support |
| `sentence` | `string` | A sentence finished playing |
| `response` | `string` | Full agent response text |
| `agentState` | `'idle' \| 'listening' \| 'thinking' \| 'speaking'` | Agent state changed |
| `toolCall` | `ToolCallResult` | The LLM invoked a tool (before its handler runs) |
| `metrics` | `TurnMetrics` | Per-turn latency after a completed reply; see [Latency metrics](#latency-metrics) |
| `error` | `Error` | Pipeline, speech session or token extension error |
| `connected` | — | Agent connected to room |
| `disconnected` | `string?` | Agent disconnected |

## Tools

Give a tool a `handler` and the agent runs it: the model gets the result and the agent speaks its answer. Anything the model says before the call ("Let me check.") is spoken while the tool runs.

```ts
const agent = new VoiceAgent({
  // ...
  tools: [{
    definition: {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    },
    handler: async ({ city }, { signal }) => fetchWeather(city, signal),
    timeoutMs: 10_000, // default 30 s
  }],
});
```

- The handler gets the parsed arguments and `{ signal, call }`. `signal` aborts on barge-in, when the agent stops, or at the timeout.
- A string result goes to the model as is, anything else as JSON (at most 16,000 characters). A thrown error, invalid JSON arguments or a timeout go back as `{"error": "..."}`, so the model can say what went wrong.
- Several calls in one reply run one after another. After three tool rounds in a turn the model is asked to answer without tools.
- The call and its result stay in the conversation context as one entry, so later turns can refer to them.
- A bare `ToolDefinition` (no handler) keeps the 0.8 behaviour: the agent emits `toolCall` and ends the turn, and the app answers with `say()`.

## Latency metrics

After each completed reply the agent emits `metrics` (milliseconds; `null` when a stage did not happen): `sttMs`, `queueMs`, `prepareMs`, `ttftMs`, `llmMs`, `ttsMs`, `overallMs`, `toolMs`, `toolCalls` and `speaker`. They are the values of the `LATENCY` log line described above. Aborted turns and `say()` emit none. When the first sentence comes after a tool call, `llmMs` and `overallMs` include the tool time. To show them on a page, publish them to the room:

```ts
agent.on('metrics', (m) => {
  agent.room?.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ type: 'metrics', ...m })), { topic: 'agent' });
});
```

## Custom Providers

Implement the plugin interface and pass it to `VoiceAgent`:

```ts
import { BaseSTTStream, type STTPlugin, type STTStreamOptions } from '@dtelecom/agents-js';

class MySTTStream extends BaseSTTStream {
  sendAudio(pcm16: Buffer): void {
    // Send audio to your STT service
  }

  async close(): Promise<void> {
    // Clean up
  }
}

class MySTT implements STTPlugin {
  createStream(options?: STTStreamOptions) {
    return new MySTTStream();
  }
}

const agent = new VoiceAgent({
  stt: new MySTT(),
  // ...
});
```

## Data Channels

Receive data channel messages from participants:

```ts
const agent = new VoiceAgent({
  // ...
  onDataMessage: (payload, participantIdentity, topic) => {
    const message = JSON.parse(new TextDecoder().decode(payload));
    console.log(`${participantIdentity} sent:`, message);
  },
});
```

### Complete-request SSML (0.5.0+)

`DtelecomTTS.synthesizeSSML(document, signal)` negotiates `dtelecom-ssml-v1`
with the server and sends one complete document unchanged. It does not use the
legacy language-tag splitter or insert language-switch silence. Servers must
explicitly enable the profile; unsupported servers are rejected before markup
is sent for synthesis.

For greetings or announcements, use:

```ts
await agent.saySSML(
  '<speak>Hello.<break time="400ms"/>Welcome back.</speak>',
  'Hello. Welcome back.',
);
```

The second argument supplies plain display and conversation-context text.
Barge-in uses the same cancellation path as `say()`. Ordinary `say()` and streamed
LLM responses remain plain text. Incremental SSML and word-timing marks are not
implemented. Server-side validation and expanded-text metering are authoritative;
see the [public SSML contract](https://x402.dtelecom.org/docs.md#ssml-dtelecom-ssml-v1). One document stays within one engine, has a 60-second output bound, and uses effective speed 0.75–1.5. No additional SSML price multiplier applies.

### OpenRouter model controls

For providers that require explicit reasoning settings or reject sampling parameters:

```ts
new OpenRouterLLM({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: 'openai/gpt-6-luna',
  reasoningEffort: 'none',
  temperature: null, // omit the temperature parameter
  providerRouting: { sort: 'latency', requireParameters: true },
});
```

These controls also apply to plain-text summarization requests. Existing callers
retain the 0.7 temperature default and omit reasoning effort unless configured.

### Optional TTS watermark (0.6.0+)

AudioSeal B is enabled only when the SDK user explicitly requests it:

```ts
const tts = new DtelecomTTS({
  serverUrl,
  sessionKey,
  voices: { en: { voice: 'M5', langCode: 'en' } },
  watermark: true,
});
```

Omitting `watermark` or setting it to `false` keeps existing unmarked speech.
The option applies to plain text and `synthesizeSSML()` independently of STT
Smart Turn/partials. The server must enable the optional feature; the provider
checks availability during warmup/first use, caches it per connection, and
requires `watermark: "active"`
before yielding PCM. It logs `TTS watermark=active (AudioSeal B)`. Unsupported
servers or failed activation produce an error, never silent unmarked output.

Watermarking buffers audio before playback. Short or interrupted speech may be difficult to detect.

## CI and live verification

`SDK checks` runs lint, tests and a build on Node 22.14.0 and 24.x. It installs the resulting npm tarball in an empty consumer project and checks the agent and speech provider exports. To repeat the package check locally, run `npm ci && npm run build`, then `bash test-support/prepare-consumer.sh "$(mktemp -d)"`.

To run the hosted media test, dispatch **SDK checks** on `main`. Configure the `sdk-live-tests` GitHub environment with `DTELECOM_CLOUD_URL`, `DTELECOM_API_KEY` and `DTELECOM_API_SECRET` and an `OPENROUTER_API_KEY` for the model. Use a Cloud project funded for WebRTC, STT and TTS. Chromium publishes a synthesized question. The test checks the recognized subject, the model's answer and audible audio received from the assistant. The job disconnects the participants after the call.

## License

Apache-2.0
