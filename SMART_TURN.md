# Smart Turn

Smart Turn uses audio at a pause to decide whether the speaker has finished. A speaker can pause mid-sentence and continue the same turn. The time until a final transcript also depends on audio delivery and transcription.

Request Smart Turn when creating the speech provider for a voice agent.

```ts
import { DtelecomSTT } from '@dtelecom/agents-js/providers';

const stt = new DtelecomSTT({
  serverUrl: session.stt.serverUrl,
  sessionKey: session.stt.token,
  language: 'en',
  smartTurn: true,
});
```

Listen for `stt_ready` on the agent after connecting or changing language. The `smartTurn` field reports the endpointing method for that stream.

| Value | Meaning |
| --- | --- |
| `active` | The server is using Smart Turn for this stream. |
| `acoustic_fallback` | The server is using ordinary silence detection. |
| Absent | The server did not report the endpointing method. |

A configuration error is reported through the agent’s `error` event. Omit `smartTurn` or set it to `false` on a new stream to use ordinary acoustic endpointing. When using raw STT, send `smart_turn` and read `smart_turn` on the raw `ready` message.

Set `partials: true` separately when your application needs provisional text. The agent uses final transcripts to start language-model turns. See the [speech controls](https://x402.dtelecom.org/docs.md#streaming-speech-controls) for the public streaming protocol.
