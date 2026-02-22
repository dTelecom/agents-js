// ─── STT Plugin ──────────────────────────────────────────────────────────────

export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
  /** Time in ms from last interim result to this final result (STT + end-of-turn). Only on isFinal. */
  sttDuration?: number;
}

export interface STTStreamOptions {
  language?: string;
}

export interface STTStream {
  sendAudio(pcm16: Buffer): void;
  on(event: 'transcription', cb: (result: TranscriptionResult) => void): this;
  on(event: 'error', cb: (error: Error) => void): this;
  close(): Promise<void>;
}

export interface STTPlugin {
  createStream(options?: STTStreamOptions): STTStream;
}

// ─── LLM Plugin ──────────────────────────────────────────────────────────────

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMChunk {
  type: 'token' | 'segment' | 'tool_call' | 'done';
  token?: string;
  segment?: { lang: string; text: string };
  toolCall?: { name: string; arguments: string };
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LLMPlugin {
  chat(messages: Message[], signal?: AbortSignal): AsyncGenerator<LLMChunk>;
  /** Optional: warm up the LLM connection with the system prompt */
  warmup?(systemPrompt: string): Promise<void>;
}

// ─── TTS Plugin ──────────────────────────────────────────────────────────────

export interface TTSPlugin {
  synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer>;
  /** Optional: pre-connect to TTS server */
  warmup?(): Promise<void>;
  /** Strip provider-specific markup from text for display/events. */
  cleanText?(text: string): string;
  /** Default language code (e.g. 'en'). Used by Pipeline to skip wrapping default-lang segments. */
  defaultLanguage?: string;
  /** Close all underlying connections (WebSockets, etc.) to allow clean process exit. */
  close?(): void;
}

// ─── Memory Config ───────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Enable persistent room memory (requires better-sqlite3, sqlite-vec, @huggingface/transformers) */
  enabled: boolean;
  /** Path to SQLite database file (default: './data/memory.db') */
  dbPath?: string;
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
  /** Max context tokens before triggering summarization (default: 5000) */
  maxContextTokens?: number;
}

export interface AgentStartOptions {
  room: string;
  apiKey: string;
  apiSecret: string;
  identity?: string;
  name?: string;
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
  /** Max context tokens before triggering summarization (default: 5000) */
  maxContextTokens?: number;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface AgentEvents {
  transcription: (result: TranscriptionResult & { speaker: string }) => void;
  /** Emitted after each sentence finishes playing via TTS. */
  sentence: (text: string) => void;
  /** Emitted after the full response finishes playing. */
  response: (text: string) => void;
  /** Agent state: idle → listening (STT active) → thinking (LLM) → speaking (audio) → idle. */
  agentState: (state: AgentState) => void;
  error: (error: Error) => void;
  connected: () => void;
  disconnected: (reason?: string) => void;
}

export interface PipelineEvents {
  transcription: (result: TranscriptionResult & { speaker: string }) => void;
  sentence: (text: string) => void;
  response: (text: string) => void;
  agentState: (state: AgentState) => void;
  error: (error: Error) => void;
}
