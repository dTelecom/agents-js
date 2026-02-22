/**
 * RoomMemory — high-level persistent memory for a room.
 *
 * Stores all conversation turns, provides semantic search,
 * and generates session summaries on session end.
 *
 * Uses SQLite + sqlite-vec for storage and local embeddings
 * via @huggingface/transformers. Everything runs in-process,
 * no external services needed.
 */

import { randomUUID } from 'crypto';
import { MemoryStore, type TurnRow, type SearchResult, type SessionSearchResult } from './memory-store';
import { Embedder } from './embedder';
import type { LLMPlugin, Message } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('RoomMemory');

/** Pending turn waiting to be embedded and stored. */
interface PendingTurn {
  speaker: string;
  text: string;
  isAgent: boolean;
}

export interface RoomMemoryConfig {
  /** Path to SQLite database file */
  dbPath: string;
  /** Room name (scopes all data) */
  room: string;
  /** Flush pending turns every N ms (default: 5000) */
  flushIntervalMs?: number;
}

export class RoomMemory {
  private readonly store: MemoryStore;
  private readonly embedder: Embedder;
  private readonly room: string;
  private sessionId: string | null = null;
  private participants = new Set<string>();
  private pendingTurns: PendingTurn[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private flushing = false;

  constructor(config: RoomMemoryConfig) {
    this.store = new MemoryStore(config.dbPath);
    this.embedder = new Embedder();
    this.room = config.room;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
  }

  /** Get the embedder instance (for reuse in other components). */
  getEmbedder(): Embedder {
    return this.embedder;
  }

  /** Initialize embedder (loads model). Call once at startup. */
  async init(): Promise<void> {
    await this.embedder.init();
  }

  /** Start a new session for this room. */
  startSession(): string {
    this.sessionId = randomUUID();
    this.participants.clear();
    this.store.insertSession(this.sessionId, this.room);

    // Start periodic flush of pending turns
    this.flushTimer = setInterval(() => {
      this.flushPending().catch((err) => {
        log.error('Error flushing pending turns:', err);
      });
    }, this.flushIntervalMs);

    log.info(`Session started: ${this.sessionId}`);
    return this.sessionId;
  }

  /** Track a participant joining. */
  addParticipant(identity: string): void {
    this.participants.add(identity);
  }

  /**
   * Store a turn to memory. Non-blocking — queues for batch embedding.
   * Call this for EVERY final transcription, even if agent doesn't respond.
   */
  storeTurn(speaker: string, text: string, isAgent: boolean): void {
    if (!this.sessionId) {
      log.warn('storeTurn called without active session');
      return;
    }

    this.pendingTurns.push({ speaker, text, isAgent });

    // Flush immediately if we have 5+ pending turns
    if (this.pendingTurns.length >= 5) {
      this.flushPending().catch((err) => {
        log.error('Error flushing pending turns:', err);
      });
    }
  }

  /** Flush pending turns: embed and insert into database. */
  private async flushPending(): Promise<void> {
    if (this.flushing || this.pendingTurns.length === 0 || !this.sessionId) return;
    this.flushing = true;

    const batch = this.pendingTurns.splice(0);
    const texts = batch.map((t) => `[${t.speaker}]: ${t.text}`);

    try {
      const embeddings = await this.embedder.embedBatch(texts);

      for (let i = 0; i < batch.length; i++) {
        const turn = batch[i];
        this.store.insertTurn(
          this.room,
          this.sessionId,
          turn.speaker,
          turn.text,
          turn.isAgent,
          embeddings[i],
        );
      }

      log.debug(`Flushed ${batch.length} turns to memory`);
    } catch (err) {
      log.error('Error embedding/storing turns:', err);
      // Put turns back for retry
      this.pendingTurns.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Search memory for context relevant to a query.
   * Returns formatted string ready to inject into LLM system prompt.
   */
  async searchRelevant(query: string, turnLimit = 5, sessionLimit = 2): Promise<string> {
    const queryEmbedding = await this.embedder.embed(query);

    const turns = this.store.searchTurns(this.room, queryEmbedding, turnLimit);
    const sessions = this.store.searchSessions(this.room, queryEmbedding, sessionLimit);

    if (turns.length === 0 && sessions.length === 0) {
      return '';
    }

    const parts: string[] = [];

    if (sessions.length > 0) {
      parts.push('Past session summaries:');
      for (const s of sessions) {
        const date = new Date(s.started_at).toLocaleDateString();
        parts.push(`  [${date}]: ${s.summary}`);
      }
    }

    if (turns.length > 0) {
      parts.push('Relevant past turns:');
      for (const t of turns) {
        const date = new Date(t.created_at).toLocaleDateString();
        const time = new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        parts.push(`  [${date} ${time}, ${t.speaker}]: ${t.text}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * End the current session. Generates an LLM summary and stores it.
   */
  async endSession(llm: LLMPlugin): Promise<void> {
    if (!this.sessionId) return;

    // Flush any remaining pending turns
    await this.flushPending();

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    const turnCount = this.store.getSessionTurnCount(this.sessionId);
    const participantList = Array.from(this.participants);

    if (turnCount < 3) {
      // Too few turns for meaningful summary
      this.store.endSession(this.sessionId, turnCount, participantList);
      log.info(`Session ended (${turnCount} turns, no summary)`);
      this.sessionId = null;
      return;
    }

    // Generate summary
    try {
      const turns = this.store.getSessionTurns(this.sessionId);
      const transcript = turns
        .map((t) => `[${t.speaker}]: ${t.text}`)
        .join('\n');

      const messages: Message[] = [
        {
          role: 'system',
          content: 'Summarize this conversation concisely. Include: key topics discussed, decisions made, and important details. Be factual and brief.',
        },
        { role: 'user', content: transcript },
      ];

      let summary = '';
      for await (const chunk of llm.chat(messages)) {
        if (chunk.type === 'token' && chunk.token) {
          summary += chunk.token;
        }
      }

      if (summary.trim()) {
        const embedding = await this.embedder.embed(summary.trim());
        this.store.updateSessionSummary(
          this.sessionId,
          summary.trim(),
          turnCount,
          participantList,
          embedding,
        );
        log.info(`Session ended with summary (${turnCount} turns, ${participantList.length} participants)`);
      } else {
        this.store.endSession(this.sessionId, turnCount, participantList);
        log.info(`Session ended (${turnCount} turns, summary was empty)`);
      }
    } catch (err) {
      log.error('Error generating session summary:', err);
      this.store.endSession(this.sessionId, turnCount, participantList);
    }

    this.sessionId = null;
  }

  /** Close the memory store. Flush pending turns first. */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flushPending();
    this.store.close();
  }
}
