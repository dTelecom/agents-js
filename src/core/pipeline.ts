/**
 * Pipeline — coordinates the STT -> LLM -> TTS flow.
 *
 * Uses a producer/consumer pattern:
 * - Producer: LLM tokens -> sentence splitter -> sentence queue
 * - Consumer: sentence queue -> TTS -> audio output
 * Both run concurrently so audio playback never blocks LLM consumption.
 *
 * Supports barge-in (interruption cancels both producer and consumer).
 */

import { EventEmitter } from 'events';
import type {
  STTPlugin,
  STTStream,
  LLMPlugin,
  TTSPlugin,
  TranscriptionResult,
  RespondMode,
  PipelineOptions,
  PipelineEvents,
  AgentState,
} from './types';
import { ContextManager } from './context-manager';
import { SentenceSplitter } from './sentence-splitter';
import { TurnDetector } from './turn-detector';
import { BargeIn } from './barge-in';
import type { AudioOutput } from '../room/audio-output';
import type { RoomMemory } from '../memory/room-memory';
import { createLogger } from '../utils/logger';

const log = createLogger('Pipeline');

/**
 * Estimated latency from AudioSource.captureFrame() to the client hearing it:
 * Opus encode → RTP → SFU → client → jitter buffer → decode.
 * We delay the "speaking: false" emission by this amount so the UI status
 * matches what the user actually hears.
 */
const AUDIO_DRAIN_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Pipeline extends EventEmitter {
  private readonly stt: STTPlugin;
  private readonly llm: LLMPlugin;
  private readonly tts: TTSPlugin | undefined;
  private readonly audioOutput: AudioOutput;
  private readonly context: ContextManager;
  private readonly turnDetector: TurnDetector;
  private readonly bargeIn: BargeIn;
  private readonly splitter: SentenceSplitter;
  private readonly respondMode: RespondMode;
  private readonly agentName: string;
  private readonly nameVariants: string[];
  private readonly beforeRespond?: (speaker: string, text: string) => boolean | Promise<boolean>;
  private readonly memory?: RoomMemory;

  /** Strip provider-specific markup (e.g. SSML lang tags) for display. */
  private cleanText(text: string): string {
    return this.tts?.cleanText ? this.tts.cleanText(text) : text;
  }

  /** Active STT streams, keyed by participant identity */
  private sttStreams = new Map<string, STTStream>();

  private _processing = false;
  private _running = false;
  private _agentState: AgentState = 'idle';
  /** Queued turn while current one is still processing */
  private pendingTurn: { speaker: string; text: string } | null = null;

  constructor(options: PipelineOptions) {
    super();
    this.stt = options.stt;
    this.llm = options.llm;
    this.tts = options.tts;
    this.audioOutput = options.audioOutput;
    this.respondMode = options.respondMode ?? 'always';
    this.agentName = (options.agentName ?? 'assistant').toLowerCase();
    this.nameVariants = (options.nameVariants ?? []).map((n) => n.toLowerCase());
    this.beforeRespond = options.beforeRespond;
    this.memory = options.memory;
    this.context = new ContextManager({
      instructions: options.instructions,
      maxContextTokens: options.maxContextTokens,
    });
    this.turnDetector = new TurnDetector({
      silenceTimeoutMs: options.silenceTimeoutMs,
    });
    this.bargeIn = new BargeIn();
    this.splitter = new SentenceSplitter();

    this.turnDetector.onTurnEnd = () => {};

    this.bargeIn.onInterrupt = () => {
      this.audioOutput.flush();
      this.splitter.reset();
      this.setAgentState('idle');
    };

    // Warm up LLM/TTS in background (fire-and-forget)
    this._warmupPromise = this.warmup(options.instructions);
  }

  /** One-shot warmup — safe to call from constructor, resolves when both LLM and TTS are ready. */
  private _warmupPromise: Promise<void>;

  private async warmup(instructions: string): Promise<void> {
    const tasks: Promise<void>[] = [];
    if (this.llm.warmup) {
      tasks.push(
        this.llm.warmup(instructions).catch((err: unknown) => {
          log.warn('LLM warmup failed:', err);
        }),
      );
    }
    if (this.tts?.warmup) {
      tasks.push(
        this.tts.warmup().catch((err: unknown) => {
          log.warn('TTS warmup failed:', err);
        }),
      );
    }
    await Promise.all(tasks);
  }

  get processing(): boolean {
    return this._processing;
  }

  get running(): boolean {
    return this._running;
  }

  get agentState(): AgentState {
    return this._agentState;
  }

  private setAgentState(state: AgentState): void {
    if (this._agentState !== state) {
      this._agentState = state;
      this.emit('agentState', state);
    }
  }

  addParticipant(identity: string): STTStream {
    const existing = this.sttStreams.get(identity);
    if (existing) {
      existing.close();
      this.sttStreams.delete(identity);
      log.info(`Replacing STT stream for "${identity}"`);
    }

    const stream = this.stt.createStream();
    this.sttStreams.set(identity, stream);
    this._running = true;

    stream.on('transcription', (result) => {
      this.handleTranscription(identity, result);
    });

    stream.on('error', (error) => {
      log.error(`STT error for ${identity}:`, error);
      this.emit('error', error);
    });

    log.info(`STT stream started for participant "${identity}"`);
    return stream;
  }

  async removeParticipant(identity: string): Promise<void> {
    const stream = this.sttStreams.get(identity);
    if (stream) {
      await stream.close();
      this.sttStreams.delete(identity);
      log.info(`STT stream removed for participant "${identity}"`);
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    this.turnDetector.reset();
    this.bargeIn.reset();
    this.splitter.reset();

    for (const [, stream] of this.sttStreams) {
      await stream.close();
    }
    this.sttStreams.clear();

    log.info('Pipeline stopped');
  }

  getContextManager(): ContextManager {
    return this.context;
  }

  private lastFinalAt = 0;
  private lastSttDuration = 0;

  private async handleTranscription(speaker: string, result: TranscriptionResult): Promise<void> {
    this.emit('transcription', { ...result, speaker });

    // Non-empty interim → user is speaking
    if (!result.isFinal && result.text.trim()) {
      this.setAgentState('listening');
    }

    if (this.audioOutput.playing && result.text.trim().length > 0) {
      this.bargeIn.trigger();
    }

    if (result.isFinal && result.text.trim()) {
      const text = result.text.trim();
      this.lastFinalAt = performance.now();
      this.lastSttDuration = result.sttDuration ?? 0;

      // Store every turn to memory (async, non-blocking)
      this.memory?.storeTurn(speaker, text, false);

      if (await this.shouldRespond(speaker, text)) {
        this.processTurn(speaker, text);
      } else {
        log.info(`Not responding to "${speaker}": "${text.slice(0, 60)}" (mode=${this.respondMode})`);
        this.setAgentState('idle');
      }
    } else if (result.isFinal) {
      // Empty final or no text — user stopped speaking without a usable turn
      this.setAgentState('idle');
    }
  }

  /**
   * Determine if the agent should respond to this turn.
   * In 'always' mode: responds to everything.
   * In 'addressed' mode: only when agent name is mentioned + optional beforeRespond hook.
   */
  private async shouldRespond(speaker: string, text: string): Promise<boolean> {
    if (this.respondMode === 'always') return true;

    // Check if agent name or variants are mentioned
    const lower = text.toLowerCase();
    const nameMatch = lower.includes(this.agentName) ||
      this.nameVariants.some((v) => lower.includes(v));

    if (!nameMatch) return false;

    // If beforeRespond hook exists, let it decide
    if (this.beforeRespond) {
      return this.beforeRespond(speaker, text);
    }

    return true;
  }

  private async processTurn(speaker: string, text: string): Promise<void> {
    if (this._processing) {
      log.info(`Queuing turn (current still processing): "${text}"`);
      this.pendingTurn = { speaker, text };
      this.bargeIn.trigger();
      return;
    }

    this._processing = true;
    await this._warmupPromise;

    // ── Latency tracking ──
    const tSpeechEnd = this.lastFinalAt;
    const sttDuration = this.lastSttDuration;
    let tLlmFirstToken = 0;
    let tFirstSentence = 0;
    let tFirstAudioPlayed = 0;

    log.info(`Processing turn from "${speaker}": ${text}`);

    try {
      this.context.addUserTurn(speaker, text);

      if (this.context.shouldSummarize()) {
        await this.context.summarize(this.llm);
      }

      const signal = this.bargeIn.startCycle();

      // Search memory for relevant past context
      let memoryContext = '';
      if (this.memory) {
        try {
          memoryContext = await this.memory.searchRelevant(text);
        } catch (err) {
          log.warn('Memory search failed:', err);
        }
      }

      const messages = this.context.buildMessages(memoryContext || undefined);
      let fullResponse = '';

      this.setAgentState('thinking');

      // ── Producer/Consumer pattern ──
      const sentenceQueue: string[] = [];
      let producerDone = false;
      let wakeConsumer: (() => void) | null = null;

      const wake = () => { wakeConsumer?.(); };

      /** Push a sentence to the queue with first-sentence tracking. */
      let isFirstSentence = true;
      const pushSentence = (text: string) => {
        if (signal.aborted) return;
        if (isFirstSentence) {
          tFirstSentence = performance.now();
          isFirstSentence = false;
          log.info(`first_sentence: ${(tFirstSentence - tSpeechEnd).toFixed(0)}ms — "${text.slice(0, 60)}"`);
        }
        sentenceQueue.push(text);
        wake();
      };

      // ── Producer: consume LLM stream, split into sentences ──
      const producer = async () => {
        let isFirstChunk = true;

        // Segment accumulation: collect segments, flush at sentence boundaries
        // so that language tags stay intact and sentences aren't fragmented.
        const defaultLang = this.tts?.defaultLanguage;
        const segBuf: Array<{ lang: string; text: string }> = [];

        const flushSegments = () => {
          if (segBuf.length === 0) return;

          const combined = segBuf
            .map((s) =>
              s.lang !== defaultLang
                ? `<lang xml:lang="${s.lang}">${s.text}</lang>`
                : s.text,
            )
            .join(' ');
          segBuf.length = 0;
          pushSentence(combined);
        };

        const llmStream = this.llm.chat(messages, signal);
        try {
          while (!signal.aborted) {
            const { value: chunk, done } = await llmStream.next();
            if (done || !chunk) break;
            if (signal.aborted) break;

            if (chunk.type === 'segment' && chunk.segment) {
              // Structured output: accumulate segments, flush at sentence boundaries
              if (isFirstChunk) {
                tLlmFirstToken = performance.now();
                isFirstChunk = false;
                log.info(`llm_first_segment: ${(tLlmFirstToken - tSpeechEnd).toFixed(0)}ms`);
              }

              // Track clean text for context/memory (not JSON)
              if (fullResponse) fullResponse += ' ';
              fullResponse += chunk.segment.text;

              segBuf.push(chunk.segment);

              // Flush at sentence boundaries (.!? optionally followed by quotes/parens)
              if (/[.!?]["'»)]*\s*$/.test(chunk.segment.text)) {
                flushSegments();
              }
            } else if (chunk.type === 'token' && chunk.token) {
              // Plain text mode (no structured output)
              if (isFirstChunk) {
                tLlmFirstToken = performance.now();
                isFirstChunk = false;
                log.info(`llm_first_token: ${(tLlmFirstToken - tSpeechEnd).toFixed(0)}ms`);
              }

              fullResponse += chunk.token;

              const sentences = this.splitter.push(chunk.token);
              for (const sentence of sentences) {
                pushSentence(sentence);
              }
            }
          }
        } finally {
          await llmStream.return(undefined);
        }

        // Flush remaining text
        if (!signal.aborted) {
          flushSegments();
          const remaining = this.splitter.flush();
          if (remaining) {
            pushSentence(remaining);
          }

          if (!fullResponse.trim()) {
            log.warn('LLM produced no output (empty response or no segments detected)');
          }
        }

        producerDone = true;
        wake();
      };

      // ── Consumer: synthesize sentences and play audio ──
      // beginResponse/endResponse suppresses silence injection between
      // sentences so partial frames in AudioSource don't get corrupted.
      const consumer = async () => {
        this.audioOutput.beginResponse();
        try {
          while (true) {
            if (signal.aborted) break;

            if (sentenceQueue.length > 0) {
              const sentence = sentenceQueue.shift()!;
              // Skip sentences with no word characters (e.g. stray quotes/punctuation)
              if (!/\w/.test(sentence)) {
                log.debug(`Skipping non-word sentence: "${sentence}"`);
                continue;
              }
              await this.synthesizeAndPlay(sentence, signal, (t) => {
                if (!tFirstAudioPlayed) {
                  tFirstAudioPlayed = t;
                  this.setAgentState('speaking');
                }
                this.emit('sentence', this.cleanText(sentence));
              });
              continue;
            }

            if (producerDone) break;

            // Wait for producer to push a sentence
            await new Promise<void>((resolve) => {
              wakeConsumer = resolve;
            });
            wakeConsumer = null;
          }
        } finally {
          if (!signal.aborted) {
            await this.audioOutput.writeSilence(40);
          }
          this.audioOutput.endResponse();
        }
      };

      await Promise.all([producer(), consumer()]);

      // ── Latency summary ──
      // STT:  last interim (≈ end of speech) → final transcript received
      // LLM:  final transcript → first complete sentence (TTFT + accumulation)
      // TTS:  first sentence ready → first audio chunk to WebRTC
      // Overall: STT + LLM + TTS
      const ttftMs = tLlmFirstToken ? tLlmFirstToken - tSpeechEnd : 0;
      const llmMs = tFirstSentence ? tFirstSentence - tSpeechEnd : 0;
      const ttsMs = tFirstAudioPlayed && tFirstSentence ? tFirstAudioPlayed - tFirstSentence : 0;
      const overallMs = sttDuration + llmMs + ttsMs;

      log.info(
        `LATENCY "${text.slice(0, 30)}": ` +
        `STT=${sttDuration.toFixed(0)}ms ` +
        `LLM=${llmMs.toFixed(0)}ms (TTFT=${ttftMs.toFixed(0)}ms) ` +
        `TTS=${ttsMs.toFixed(0)}ms ` +
        `Overall=${overallMs.toFixed(0)}ms`,
      );

      if (fullResponse.trim()) {
        this.context.addAgentTurn(fullResponse.trim());
        this.memory?.storeTurn('assistant', fullResponse.trim(), true);
        this.emit('response', this.cleanText(fullResponse.trim()));
      }

      // Wait for audio pipeline to drain before signaling "listening"
      // (AudioSource → Opus → RTP → SFU → client decode)
      await sleep(AUDIO_DRAIN_MS);
      this.setAgentState('idle');
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.debug('Turn processing aborted (barge-in)');
      } else {
        log.error('Error processing turn:', err);
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._processing = false;
      this.bargeIn.reset();

      if (this.pendingTurn) {
        const { speaker: nextSpeaker, text: nextText } = this.pendingTurn;
        this.pendingTurn = null;
        log.info(`Processing queued turn from "${nextSpeaker}": ${nextText}`);
        this.processTurn(nextSpeaker, nextText);
      }
    }
  }

  /**
   * Speak text directly via TTS, bypassing the LLM.
   * Supports barge-in — if a participant speaks, the playback is cut short.
   * Adds the text to conversation context so the LLM knows what was said.
   */
  async say(text: string): Promise<void> {
    if (this._processing) {
      log.warn('say() called while processing — skipping');
      return;
    }

    this._processing = true;
    await this._warmupPromise;
    log.info(`say(): "${text.slice(0, 60)}"`);

    try {
      const signal = this.bargeIn.startCycle();
      this.audioOutput.beginResponse();
      this.setAgentState('thinking');

      await this.synthesizeAndPlay(text, signal, () => {
        this.setAgentState('speaking');
        this.emit('sentence', this.cleanText(text));
      });

      if (!signal.aborted) {
        await this.audioOutput.writeSilence(40);
        this.context.addAgentTurn(text);
        this.memory?.storeTurn('assistant', text, true);
        this.emit('response', this.cleanText(text));
      }

      // Wait for audio pipeline to drain before signaling "listening"
      await sleep(AUDIO_DRAIN_MS);
      this.setAgentState('idle');
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.debug('say() aborted (barge-in)');
      } else {
        log.error('Error in say():', err);
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._processing = false;
      this.audioOutput.endResponse();
      this.bargeIn.reset();

      if (this.pendingTurn) {
        const { speaker: nextSpeaker, text: nextText } = this.pendingTurn;
        this.pendingTurn = null;
        log.info(`Processing queued turn from "${nextSpeaker}": ${nextText}`);
        this.processTurn(nextSpeaker, nextText);
      }
    }
  }

  private async synthesizeAndPlay(
    text: string,
    signal: AbortSignal,
    onFirstAudio: (timestamp: number) => void,
  ): Promise<void> {
    if (!this.tts || signal.aborted) {
      log.info(`[Agent says]: ${text}`);
      return;
    }

    try {
      const ttsStart = performance.now();
      let firstChunk = true;
      let ttsChunkCount = 0;

      const ttsStream = this.tts.synthesize(text, signal);
      const measuredStream = async function* () {
        for await (const chunk of ttsStream) {
          ttsChunkCount++;
          if (firstChunk) {
            firstChunk = false;
            const now = performance.now();
            log.info(`tts_first_audio: ${(now - ttsStart).toFixed(0)}ms for "${text.slice(0, 40)}"`);
            onFirstAudio(now);
          }
          yield chunk;
        }
      };

      await this.audioOutput.writeStream(measuredStream(), signal);
      log.info(`synthesizeAndPlay done: ${(performance.now() - ttsStart).toFixed(0)}ms, ${ttsChunkCount} chunks for "${text.slice(0, 40)}"`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    }
  }
}
