/**
 * @dtelecom/agents — AI voice agent framework for dTelecom rooms.
 *
 * Quick start:
 * ```ts
 * import { VoiceAgent } from '@dtelecom/agents';
 * import { DeepgramSTT, OpenRouterLLM, CartesiaTTS } from '@dtelecom/agents/providers';
 *
 * const agent = new VoiceAgent({
 *   stt: new DeepgramSTT({ apiKey: '...' }),
 *   llm: new OpenRouterLLM({ apiKey: '...', model: 'openai/gpt-4o' }),
 *   tts: new CartesiaTTS({ apiKey: '...', voiceId: '...' }),
 *   instructions: 'You are a helpful assistant.',
 * });
 *
 * await agent.start({
 *   room: 'my-room',
 *   apiKey: process.env.DTELECOM_API_KEY!,
 *   apiSecret: process.env.DTELECOM_API_SECRET!,
 * });
 * ```
 *
 * Providers are imported from `@dtelecom/agents/providers` to keep the
 * core bundle lean. Unused providers are never loaded.
 */

// Core
export { VoiceAgent } from './core/voice-agent';
export { Pipeline } from './core/pipeline';
export { ContextManager } from './core/context-manager';
export type { ContextManagerOptions } from './core/context-manager';
export { SentenceSplitter } from './core/sentence-splitter';
export { TurnDetector } from './core/turn-detector';
export type { TurnDetectorOptions } from './core/turn-detector';
export { BargeIn } from './core/barge-in';
export { BaseSTTStream } from './core/base-stt-stream';

// Room
export { RoomConnection } from './room/room-connection';
export type { RoomConnectionOptions } from './room/room-connection';
export { AudioInput } from './room/audio-input';
export { AudioOutput } from './room/audio-output';

// Types
export type {
  STTPlugin,
  STTStream,
  STTStreamOptions,
  TranscriptionResult,
  LLMPlugin,
  LLMChunk,
  Message,
  TTSPlugin,
  RespondMode,
  AgentConfig,
  AgentStartOptions,
  AgentState,
  AgentEvents,
  MemoryConfig,
  PipelineOptions,
  PipelineEvents,
  DataMessageHandler,
} from './core/types';

// Memory is a separate entry point: import from '@dtelecom/agents-js/memory'
// Requires optional peer deps: better-sqlite3, sqlite-vec, @huggingface/transformers

// Utils
export { createLogger, setLogLevel, getLogLevel } from './utils/logger';
export type { LogLevel, Logger } from './utils/logger';
