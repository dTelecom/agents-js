/**
 * MemoryStore — SQLite + sqlite-vec database layer for room memory.
 *
 * Single .db file stores:
 * - turns: every spoken turn (full transcript)
 * - sessions: meeting metadata + LLM-generated summaries
 * - turn_vectors: embedding index for semantic turn search
 * - session_vectors: embedding index for session summary search
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createLogger } from '../utils/logger';

const log = createLogger('MemoryStore');

export interface TurnRow {
  id: number;
  room: string;
  session_id: string;
  speaker: string;
  text: string;
  is_agent: number;
  created_at: number;
}

export interface SessionRow {
  id: string;
  room: string;
  started_at: number;
  ended_at: number | null;
  participants: string | null;
  summary: string | null;
  turn_count: number;
}

export interface SearchResult {
  speaker: string;
  text: string;
  created_at: number;
  session_id: string;
  distance: number;
}

export interface SessionSearchResult {
  session_id: string;
  summary: string;
  started_at: number;
  distance: number;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    this.createTables();
    log.info(`Memory store opened: ${dbPath}`);
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        session_id TEXT NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        is_agent BOOLEAN DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        participants TEXT,
        summary TEXT,
        turn_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_turns_room_session ON turns(room, session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_room_time ON turns(room, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_room ON sessions(room);
    `);

    // Vector tables — sqlite-vec virtual tables
    // Check if they exist first (CREATE VIRTUAL TABLE doesn't support IF NOT EXISTS)
    const hasVecTable = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    );

    if (!hasVecTable.get('turn_vectors')) {
      this.db.exec(`
        CREATE VIRTUAL TABLE turn_vectors USING vec0(
          turn_id INTEGER PRIMARY KEY,
          embedding FLOAT[384] distance_metric=cosine
        );
      `);
    }

    if (!hasVecTable.get('session_vectors')) {
      this.db.exec(`
        CREATE VIRTUAL TABLE session_vectors USING vec0(
          session_id TEXT PRIMARY KEY,
          embedding FLOAT[384] distance_metric=cosine
        );
      `);
    }
  }

  /** Insert a turn and its embedding vector. */
  insertTurn(
    room: string,
    sessionId: string,
    speaker: string,
    text: string,
    isAgent: boolean,
    embedding: Float32Array,
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO turns (room, session_id, speaker, text, is_agent, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(room, sessionId, speaker, text, isAgent ? 1 : 0, Date.now());
    const turnId = info.lastInsertRowid;

    // Insert embedding vector — sqlite-vec requires BigInt for integer PKs
    this.db.prepare(
      'INSERT INTO turn_vectors (turn_id, embedding) VALUES (?, ?)',
    ).run(BigInt(turnId), Buffer.from(embedding.buffer));

    return Number(turnId);
  }

  /** Create a new session record. */
  insertSession(id: string, room: string): void {
    this.db.prepare(`
      INSERT INTO sessions (id, room, started_at)
      VALUES (?, ?, ?)
    `).run(id, room, Date.now());
  }

  /** Update a session with summary and end time. */
  updateSessionSummary(
    sessionId: string,
    summary: string,
    turnCount: number,
    participants: string[],
    embedding: Float32Array,
  ): void {
    this.db.prepare(`
      UPDATE sessions
      SET summary = ?, ended_at = ?, turn_count = ?, participants = ?
      WHERE id = ?
    `).run(summary, Date.now(), turnCount, JSON.stringify(participants), sessionId);

    // Insert summary embedding
    this.db.prepare(
      'INSERT INTO session_vectors (session_id, embedding) VALUES (?, ?)',
    ).run(sessionId, Buffer.from(embedding.buffer));
  }

  /** End a session without summary (e.g., too few turns). */
  endSession(sessionId: string, turnCount: number, participants: string[]): void {
    this.db.prepare(`
      UPDATE sessions
      SET ended_at = ?, turn_count = ?, participants = ?
      WHERE id = ?
    `).run(Date.now(), turnCount, JSON.stringify(participants), sessionId);
  }

  /** KNN search turns by embedding similarity. */
  searchTurns(room: string, queryEmbedding: Float32Array, limit: number): SearchResult[] {
    const rows = this.db.prepare(`
      SELECT t.speaker, t.text, t.created_at, t.session_id, tv.distance
      FROM turn_vectors tv
      JOIN turns t ON t.id = tv.turn_id
      WHERE t.room = ?
        AND tv.embedding MATCH ?
        AND k = ?
      ORDER BY tv.distance
    `).all(room, Buffer.from(queryEmbedding.buffer), limit * 2) as (TurnRow & { distance: number })[];

    // sqlite-vec returns k results from the vector index, then we filter by room
    return rows.slice(0, limit).map((r) => ({
      speaker: r.speaker,
      text: r.text,
      created_at: r.created_at,
      session_id: r.session_id,
      distance: r.distance,
    }));
  }

  /** KNN search session summaries by embedding similarity. */
  searchSessions(room: string, queryEmbedding: Float32Array, limit: number): SessionSearchResult[] {
    const rows = this.db.prepare(`
      SELECT s.id as session_id, s.summary, s.started_at, sv.distance
      FROM session_vectors sv
      JOIN sessions s ON s.id = sv.session_id
      WHERE s.room = ?
        AND sv.embedding MATCH ?
        AND k = ?
      ORDER BY sv.distance
    `).all(room, Buffer.from(queryEmbedding.buffer), limit * 2) as SessionSearchResult[];

    return rows
      .filter((r) => r.summary)
      .slice(0, limit);
  }

  /** Get the last N turns from a specific session. */
  getRecentTurns(room: string, sessionId: string, limit: number): TurnRow[] {
    return this.db.prepare(`
      SELECT * FROM turns
      WHERE room = ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(room, sessionId, limit) as TurnRow[];
  }

  /** Get all turns for a session (for summarization). */
  getSessionTurns(sessionId: string): TurnRow[] {
    return this.db.prepare(`
      SELECT * FROM turns
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as TurnRow[];
  }

  /** Get total turn count for a session. */
  getSessionTurnCount(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM turns WHERE session_id = ?',
    ).get(sessionId) as { count: number };
    return row.count;
  }

  /** Close the database. */
  close(): void {
    this.db.close();
    log.info('Memory store closed');
  }
}
