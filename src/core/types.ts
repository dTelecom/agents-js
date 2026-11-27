// ─── STT Plugin ──────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
  /** Time in ms from last interim result to this final result (STT + end-of-turn). Only on isFinal. */
  sttDuration?: number;
  /** Correlates provisional windows with their authoritative final. */
  utteranceId?: string;
  revision?: number;
  windowStartSeconds?: number;
  provisional?: boolean;
  replacePrevious?: boolean;
}

export interface STTPartialEnd {
  utteranceId: string;
  reason: 'finalizing' | 'discarded' | 'replaced' | 'reconfigured';
}

export interface STTReady {
  clientId?: string;
  language?: string;
  /** Reported only when requested; absence does not confirm activation. */
  smartTurn?: 'active' | 'acoustic_fallback';
  /** True when the server accepts `finalize` (see `STTStream.finalize`). */
  finalize?: boolean;
}

export interface STTStreamOptions {
  language?: string;
}

export interface STTStream {
  sendAudio(pcm16: Buffer): void;
  /** Switch language mid-session (only supported by some providers, e.g. DtelecomSTT) */
  setLanguage?(language: string, options?: { forceWhisper?: boolean }): void;
  /**
   * Ask the server to end the current utterance now and send its final transcript, instead of
   * waiting for the end-of-speech silence. Only when the server advertised it (`ready.finalize`);
   * otherwise a no-op. Returns whether the request was sent. The pipeline does not call it yet.
   */
  finalize?(): boolean;
  on(event: 'transcription', cb: (result: TranscriptionResult) => void): this;
  on(event: 'transcription_partial', cb: (result: TranscriptionResult) => void): this;
  on(event: 'partial_end', cb: (result: STTPartialEnd) => void): this;
  on(event: 'ready', cb: (result: STTReady) => void): this;
  on(event: 'error', cb: (error: Error) => void): this;
  close(): Promise<void>;
}

export interface STTPlugin {
  createStream(options?: STTStreamOptions): STTStream;
  /** Optional: dTelecom Cloud providers link their sessions to the agent's WebRTC session. */
  setWebRTCSessionId?(sessionId: string): void;
}

// ─── LLM Plugin ──────────────────────────────────────────────────────────────

/** A tool call as it appears on an assistant message (OpenAI chat format). */
export interface ToolCallPart {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * A chat message (OpenAI chat format). An assistant message that calls tools carries
 * `tool_calls`, with `content: null` when it says nothing; each result follows as a `tool`
 * message with the call's id.
 */
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: undefined }
  | { role: 'assistant'; content: string | null; tool_calls: ToolCallPart[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallResult {
  id: string;
  name: string;
  /** Raw JSON text of the arguments, as the model produced it. */
  arguments: string;
}

/** What a tool handler receives besides its arguments. */
export interface ToolContext {
  /** Aborted on barge-in, when the agent stops, or after the tool's timeout. */
  signal: AbortSignal;
  /** The call as the model made it. */
  call: ToolCallResult;
}

/**
 * Runs a tool. The return value goes back to the model: a string as is, anything else as JSON.
 * A thrown error goes back as `{"error": message}`, so the model can explain or retry.
 */
export type ToolHandler = (args: any, context: ToolContext) => unknown | Promise<unknown>;

/** A tool the agent runs itself: the model gets its result and answers with it. */
export interface AgentTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** Abort the handler after this long (default: 30000 ms); the model gets a timeout error. */
  timeoutMs?: number;
}

/**
 * A tool for the agent. With a handler (`AgentTool`) the agent runs it and speaks the model's
 * answer. A bare `ToolDefinition` only emits `toolCall` and ends the turn; the app answers with `say()`.
 */
export type Tool = ToolDefinition | AgentTool;

export interface LLMChunk {
  type: 'token' | 'segment' | 'tool_call' | 'done';
  token?: string;
  segment?: { lang: string; text: string };
  toolCall?: ToolCallResult;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMChatOptions {
  /** Skip structured output (responseFormat) for this call — return plain text tokens. */
  plainText?: boolean;
  /** Output token limit for this call instead of the provider's `maxTokens` (used by warmup). */
  maxTokens?: number;
  /** Tool definitions to pass to the LLM for function calling. */
  tools?: ToolDefinition[];
  /** 'none' asks the model to answer in text without calling a tool (sent as `tool_choice`). */
  toolChoice?: 'auto' | 'none';
}

export interface LLMPlugin {
  chat(messages: Message[], signal?: AbortSignal, options?: LLMChatOptions): AsyncGenerator<LLMChunk>;
  /** Optional: warm up the LLM connection with the system prompt */
  warmup?(systemPrompt: string): Promise<void>;
}

// ─── TTS Plugin ──────────────────────────────────────────────────────────────

export interface TTSPlugin {
  synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer>;
  /** Optional complete-document SSML; never pass through sentence splitting. */
  synthesizeSSML?(ssml: string, signal?: AbortSignal): AsyncGenerator<Buffer>;
  /** Optional: pre-connect to TTS server */
  warmup?(): Promise<void>;
  /** Strip provider-specific markup from text for display/events. */
  cleanText?(text: string): string;
  /** Default language code (e.g. 'en'). Used by Pipeline to skip wrapping default-lang segments. */
  defaultLanguage?: string;
  /** Close all underlying connections (WebSockets, etc.) to allow clean process exit. */
  close?(): void;
  /** When true, pipeline will not prefetch next sentence TTS (single-connection providers). */
  sequential?: boolean;
  /** Optional: dTelecom Cloud providers link their sessions to the agent's WebRTC session. */
  setWebRTCSessionId?(sessionId: string): void;
}

// ─── Memory Config ───────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Enable persistent room memory (requires better-sqlite3, sqlite-vec, @huggingface/transformers) */
  enabled: boolean;
  /** Path to SQLite database file (default: './data/memory.db') */
  dbPath?: string;
  /** Override room name as memory scope (e.g. userId for cross-room persistence) */
  scope?: string;
}

// ─── Agent Config ────────────────────────────────────────────────────────────

export type RespondMode = 'always' | 'addressed';

export interface AgentConfig {
  stt: STTPlugin;
  tts?: TTSPlugin;
  llm: LLMPlugin;
  instructions: string;
  /** When to respond: 'always' (1:1 mode) or 'addressed' (multi-participant). Default: 'always' */
  respondMode?: RespondMode;
  /** Agent name for addressing detection (default: 'assistant') */
  agentName?: string;
  /** Additional name variants to respond to (e.g. ['bot', 'ai']) */
  nameVariants?: string[];
  /** Called when a data channel message is received */
  onDataMessage?: DataMessageHandler;
  /** Persistent memory across sessions (stores turns, enables semantic search) */
  memory?: MemoryConfig;
  /**
   * Conversation size (turns plus summary, estimated tokens; instructions not counted) above which
   * older turns are summarized in the background (default: 5000).
   */
  maxContextTokens?: number;
  /** Tools for LLM function calling: with a handler the agent runs them, see `Tool`. */
  tools?: Tool[];
}

export interface AgentStartOptions {
  room: string;
  identity?: string;
  name?: string;

  // Mode 1: dTelecom Cloud — the cloud mints the agent's token (publish, subscribe and data)
  cloud?: import('@dtelecom/server-sdk-js').CloudClient;
  /**
   * Cloud mode: how long each room token holds, e.g. '6h' (default 6 hours, at most 24). The agent
   * extends it by the same amount before it expires, so it stays until stop().
   */
  ttl?: number | string;

  // Mode 2: dTelecom Cloud API key and secret; builds a CloudClient (base URL from DTELECOM_CLOUD_URL)
  apiKey?: string;
  apiSecret?: string;

  // Mode 3: Use pre-signed token from x402 gateway
  token?: string;
  wsUrl?: string;
  /** Ranked signaling URLs returned with a pre-signed grant. */
  fallbackUrls?: string[];
}

// ─── Data Channel ────────────────────────────────────────────────────────────

export type DataMessageHandler = (
  payload: Uint8Array,
  participantIdentity: string,
  topic?: string,
) => void;

// ─── Pipeline Options ────────────────────────────────────────────────────────

export interface PipelineOptions {
  stt: STTPlugin;
  llm: LLMPlugin;
  tts?: TTSPlugin;
  instructions: string;
  audioOutput: import('../room/audio-output').AudioOutput;
  /** Silence timeout for turn detection (default: 800ms) */
  silenceTimeoutMs?: number;
  /** When to respond: 'always' or 'addressed' (default: 'always') */
  respondMode?: RespondMode;
  /** Agent name for addressing detection */
  agentName?: string;
  /** Additional name variants */
  nameVariants?: string[];
  /**
   * Hook called before responding to a turn. Return false to skip responding.
   * Use for custom response logic (e.g., keyword filtering, rate limiting).
   */
  beforeRespond?: (speaker: string, text: string) => boolean | Promise<boolean>;
  /** Room memory instance (injected by VoiceAgent if memory is enabled) */
  memory?: import('../memory/room-memory').RoomMemory;
  /**
   * Conversation size (turns plus summary, estimated tokens; instructions not counted) above which
   * older turns are summarized in the background (default: 5000).
   */
  maxContextTokens?: number;
  /** Tools for LLM function calling: with a handler the agent runs them, see `Tool`. */
  tools?: Tool[];
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Latency of one completed turn, in milliseconds; null when that stage did not happen.
 * Emitted as `metrics` after the turn's reply, not for aborted turns or `say()`.
 */
export interface TurnMetrics {
  speaker: string;
  /** STT processing time reported by the server (from the last interim to the final). */
  sttMs: number;
  /** Final transcript received → turn started (waiting for a previous turn). */
  queueMs: number;
  /** Turn started → LLM request (warmup, memory search). */
  prepareMs: number;
  /** LLM request → first token. */
  ttftMs: number | null;
  /** LLM request → first complete sentence. Includes tool time when the first sentence follows a tool call. */
  llmMs: number | null;
  /** First sentence → first audio sent. */
  ttsMs: number | null;
  /** stt + queue + prepare + llm + tts: speech end (excluding end-of-speech detection) to first audio. */
  overallMs: number | null;
  /** Total time in tool handlers; 0 without tool calls. */
  toolMs: number;
  /** Tool calls made during the turn. */
  toolCalls: number;
}

export interface AgentEvents {
  transcription: (result: TranscriptionResult & { speaker: string }) => void;
  transcription_partial: (result: TranscriptionResult & { speaker: string }) => void;
  partial_end: (result: STTPartialEnd & { speaker: string }) => void;
  stt_ready: (result: STTReady & { speaker: string }) => void;
  /** Emitted after each sentence finishes playing via TTS. */
  sentence: (text: string) => void;
  /** Emitted after the full response finishes playing. */
  response: (text: string) => void;
  /** Agent state: idle → listening (STT active) → thinking (LLM) → speaking (audio) → idle. */
  agentState: (state: AgentState) => void;
  /** Emitted when the LLM invokes a tool, before a handler runs. */
  toolCall: (toolCall: ToolCallResult) => void;
  /** Per-turn latency after each completed reply. */
  metrics: (metrics: TurnMetrics) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: (reason?: string) => void;
}

export interface PipelineEvents {
  transcription: (result: TranscriptionResult & { speaker: string }) => void;
  transcription_partial: (result: TranscriptionResult & { speaker: string }) => void;
  partial_end: (result: STTPartialEnd & { speaker: string }) => void;
  stt_ready: (result: STTReady & { speaker: string }) => void;
  sentence: (text: string) => void;
  response: (text: string) => void;
  agentState: (state: AgentState) => void;
  /** Emitted when the LLM invokes a tool, before a handler runs. */
  toolCall: (toolCall: ToolCallResult) => void;
  metrics: (metrics: TurnMetrics) => void;
  error: (error: Error) => void;
}
