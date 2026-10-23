# @dtelecom/agents-js

AI voice agent framework for [dTelecom](https://dtelecom.org) rooms. Build real-time voice agents that join WebRTC rooms and interact with participants using speech-to-text, LLMs, and text-to-speech.

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

Cancellation covers warmup, conversation summarization, memory lookup and response generation. Cancelled summaries do not replace conversation history. A final transcript arriving during a response occupies a single pending-turn slot (the latest final replaces any earlier pending final) and interrupts the current cycle. The next cycle starts after the active provider tasks finish cancellation cleanup. An `APIUserAbortError` from an aborted cycle is expected cancellation; genuine provider failures remain errors.

Latency logs separate `Queue` (final transcript received to response-cycle start), `Prepare` (warmup, summary and memory lookup), `LLM` (request to first sentence, including `TTFT`) and `TTS` (first sentence to first audio). `STT` is server-reported processing time. `Overall` includes those phases but excludes STT endpointing wait; it is unavailable for turns without a text response. These measurements are not microphone-to-speaker latency.

For dTelecom TTS, cancellation sends `clear` and waits for `cleared` before reusing the WebSocket. Late audio from the cancelled request is discarded. A missing acknowledgement closes the connection after five seconds so a subsequent request reconnects; this is an error timeout, not a delay applied to successful cancellations.

## Install

```bash
npm install @dtelecom/agents-js @dtelecom/server-sdk-js @dtelecom/server-sdk-node
```

## Quick Start (other providers)

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

## dTelecom gateway speech

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

The client joins with `session.webrtc.client`. STT is $0.004/connected session minute; TTS is $0.006/1,000 spoken Unicode code points; WebRTC is $0.001/audio participant minute. Two participants, one STT session and 500 TTS characters/minute cost $0.009/minute, excluding LLM charges. [Live pricing and enabled services](https://x402.dtelecom.org/v1/pricing).

This framework runs live voice agents. Translation, file transcription/diarization, WAV jobs, vision and moderation use the separate [x402 client SDK](https://github.com/dTelecom/x402-client); they are not automatically invoked by VoiceAgent.

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

Both options are omitted by default, preserving existing final-only behavior. `partials` requests replaceable recognition windows. The provider sends `smartTurn` as `smart_turn`; it requires a configured server model and supported ANE VAD language route. These choices survive language changes and reconnects.

With this provider in `VoiceAgent`, subscribe to:

- `transcription_partial`: `{ text, isFinal: false, utteranceId, revision, windowStartSeconds, provisional: true, replacePrevious: true, speaker }`. Replace the displayed provisional window; do not append it to committed text.
- `partial_end`: `{ utteranceId, reason, speaker }`. Clear provisional text on `finalizing`, `discarded`, `replaced` or `reconfigured`.
- `transcription`: partials also appear here with `isFinal: false`; finals carry the same `utteranceId` and supersede them. Only finals start an LLM turn. Nonempty partials can trigger barge-in while the agent is speaking.
- `stt_ready`: `{ clientId?, language?, smartTurn?, speaker }`. `smartTurn: "active"` confirms the semantic hook; `"acoustic_fallback"` reports silence detection. An absent field does not confirm activation. Missing server-model errors surface through `error`.

Raw `STTStream` exposes the same events without `speaker`, with `ready` instead of `stt_ready`. Providers other than dTelecom may not emit these optional event types. For transcript display, subscribe to either `transcription_partial` or nonfinal `transcription`, not both.

Smart Turn defaults to off. Current server defaults are completion threshold 0.5, minimum pause 500 ms, maximum 2 seconds of received silence and classifier deadline 250 ms. These are not end-to-end latency guarantees. Use server-sdk-node 0.2.6 or later to supply silence during Opus DTX/input stalls. See [Smart Turn integration notes](SMART_TURN.md) for current behavior and separately dated historical acceptance results.

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

## Events

| Event | Payload | Description |
|---|---|---|
| `transcription` | `{ text, isFinal, speaker, utteranceId? }` | Final or provisional STT result |
| `transcription_partial` | `{ text, utteranceId, revision, windowStartSeconds, speaker }` | Replace temporary display text |
| `partial_end` | `{ utteranceId, reason, speaker }` | Clear temporary display text |
| `stt_ready` | `{ clientId?, language?, smartTurn?, speaker }` | Check active/fallback endpointing |
| `response` | `string` | Full agent response text |
| `speaking` | `boolean` | Agent started/stopped speaking |
| `error` | `Error` | Pipeline error |
| `connected` | — | Agent connected to room |
| `disconnected` | `string?` | Agent disconnected |

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

The accepted B configuration runs on 48 kHz float audio after TTS resampling
and SSML gain, before PCM16/Opus. It adds an 80 ms input buffer and approximately
5 ms inference in the M6 lab; live timing depends on load and audio arrival.
No filter or resampling is applied after watermarking. Short/interrupted speech
may not remain detectable. This option is off by default even on capable servers.

## License

Apache-2.0
