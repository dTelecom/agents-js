# @dtelecom/agents

AI voice agent framework for [dTelecom](https://dtelecom.org) rooms. Build real-time voice agents that join WebRTC rooms and interact with participants using speech-to-text, LLMs, and text-to-speech.

## Architecture

```
Participant mic -> SFU -> server-sdk-node (Opus decode) -> PCM16 16kHz
  -> STT plugin -> transcription
  -> LLM plugin -> streaming text response
  -> Sentence splitter -> TTS plugin -> PCM16 16kHz
  -> AudioSource (upsample 48kHz + Opus encode) -> SFU -> Participants
```

The pipeline uses a producer/consumer pattern: LLM tokens are split into sentences and queued, while a consumer synthesizes and plays audio concurrently. This minimizes time-to-first-audio.

## Install

```bash
npm install @dtelecom/agents @dtelecom/server-sdk-js @dtelecom/server-sdk-node
```

## Quick Start

```ts
import { VoiceAgent, setLogLevel } from '@dtelecom/agents';
import { DeepgramSTT, OpenRouterLLM, CartesiaTTS } from '@dtelecom/agents/providers';

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
| `transcription` | `{ text, isFinal, speaker }` | STT transcription result |
| `response` | `string` | Full agent response text |
| `speaking` | `boolean` | Agent started/stopped speaking |
| `error` | `Error` | Pipeline error |
| `connected` | — | Agent connected to room |
| `disconnected` | `string?` | Agent disconnected |

## Custom Providers

Implement the plugin interface and pass it to `VoiceAgent`:

```ts
import { BaseSTTStream, type STTPlugin, type STTStreamOptions } from '@dtelecom/agents';

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

## License

Apache-2.0
