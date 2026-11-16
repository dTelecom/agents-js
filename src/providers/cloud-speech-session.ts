/**
 * CloudSpeechSession — a dTelecom Cloud STT or TTS session behind one speech-server socket.
 *
 * Holds are small and grow on demand: STT is prepaid in time chunks and extended before it runs
 * out; TTS in character chunks, extended before a text would pass the limit and before its
 * 30-minute window closes. Every extension yields a new session key, which the owner sends to the
 * open socket as {"type":"extend","session_key":...}. A session key serves one connection: after a
 * disconnect, the owner closes this session and opens a new one.
 */

import type { CloudClient } from '@dtelecom/server-sdk-js';
import { createLogger } from '../utils/logger';
import { toStreamUrl } from './stream-url';

const log = createLogger('CloudSpeechSession');

const RETRY_MS = 15_000;
/** TTS sessions run in 30-minute windows; extend this long before one closes. */
const TTS_WINDOW_MARGIN_MS = 2 * 60_000;

export interface CloudSTTSessionOptions {
  /** Minutes held per chunk (default 10). */
  minutes?: number;
  /** Extend when fewer minutes than this remain (default 2). */
  extendWhenMinutesLeft?: number;
}

export interface CloudTTSSessionOptions {
  /** Characters held per chunk (default 2000). */
  characters?: number;
  /** Extend when fewer characters than this would remain (default 500). */
  extendWhenCharactersLeft?: number;
}

export interface CloudSpeechSessionConfig {
  kind: 'stt' | 'tts';
  cloud: CloudClient;
  language?: string;
  voice?: string;
  stt?: CloudSTTSessionOptions;
  tts?: CloudTTSSessionOptions;
  /** Called with each new session key after an extension. */
  onExtended: (sessionKey: string) => void;
  /** Called when an extension keeps failing; the session ends at its expiry. */
  onError: (error: Error) => void;
}

export class CloudSpeechSession {
  sessionId = '';
  token = '';
  serverUrl = '';
  /** WebSocket address of the session's stream. */
  streamUrl = '';
  private expiresAt = 0;
  private maxCharacters = 0;
  private usedCharacters = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private extending: Promise<void> | null = null;
  private closed = false;

  private readonly minutes: number;
  private readonly minutesLeft: number;
  private readonly characters: number;
  private readonly charactersLeft: number;

  constructor(private readonly config: CloudSpeechSessionConfig) {
    this.minutes = positive(config.stt?.minutes, 10, 'minutes');
    this.minutesLeft = positive(config.stt?.extendWhenMinutesLeft, 2, 'extendWhenMinutesLeft');
    this.characters = positive(config.tts?.characters, 2000, 'characters');
    this.charactersLeft = positive(config.tts?.extendWhenCharactersLeft, 500, 'extendWhenCharactersLeft');
    if (this.minutesLeft >= this.minutes) {
      throw new Error('extendWhenMinutesLeft must be below minutes');
    }
  }

  /** Creates the cloud session, linked to the agent's WebRTC session when one is given. */
  async open(webrtcSessionId?: string): Promise<void> {
    const { cloud, kind, language, voice } = this.config;
    const session = kind === 'stt'
      ? await cloud.stt.createSession({ duration: this.minutes * 60, language, webrtcSessionId })
      : await cloud.tts.createSession({ maxCharacters: this.characters, language, voice, webrtcSessionId });
    this.sessionId = session.sessionId;
    this.token = session.token;
    this.serverUrl = session.serverUrl;
    // server-sdk-js before 4.2 has no streamUrl.
    this.streamUrl = (session as { streamUrl?: string }).streamUrl ?? toStreamUrl(session.serverUrl);
    this.expiresAt = session.expiresAt.getTime();
    this.maxCharacters = kind === 'tts' ? this.characters : 0;
    log.info(`Cloud ${kind.toUpperCase()} session ${this.sessionId} on ${this.serverUrl}`);
    this.schedule();
  }

  /**
   * Makes room for `count` more TTS characters before they are sent: extends while the text would
   * leave fewer than the threshold. Counts the characters as used.
   */
  async reserveCharacters(count: number): Promise<void> {
    while (!this.closed && this.usedCharacters + count > this.maxCharacters - this.charactersLeft) {
      const needed = this.usedCharacters + count + this.charactersLeft - this.maxCharacters;
      await this.extend(Math.max(this.characters, needed));
    }
    this.usedCharacters += count;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Time-based extension: STT before its minutes run out, TTS before its window closes. */
  private schedule(delayMs?: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const margin = this.config.kind === 'stt' ? this.minutesLeft * 60_000 : TTS_WINDOW_MARGIN_MS;
    const delay = delayMs ?? Math.max(this.expiresAt - margin - Date.now(), 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.extend(this.config.kind === 'stt' ? this.minutes : this.characters).catch(() => {
        // extend reported it; try again while the session is still alive
        if (Date.now() + RETRY_MS < this.expiresAt) this.schedule(RETRY_MS);
      });
    }, delay);
    this.timer.unref?.();
  }

  /** One extension at a time; concurrent callers wait for the running one. */
  private extend(amount: number): Promise<void> {
    if (this.extending) return this.extending;
    this.extending = this.runExtend(amount).finally(() => {
      this.extending = null;
    });
    return this.extending;
  }

  private async runExtend(amount: number): Promise<void> {
    const { cloud, kind } = this.config;
    try {
      if (kind === 'stt') {
        const extended = await cloud.stt.extend(this.sessionId, amount * 60);
        this.token = extended.token;
        this.expiresAt = extended.expiresAt.getTime();
      } else {
        const extended = await cloud.tts.extend(this.sessionId, amount);
        this.token = extended.token;
        this.expiresAt = extended.expiresAt.getTime();
        this.maxCharacters = extended.maxCharacters;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Cloud ${kind.toUpperCase()} session ${this.sessionId} extension failed:`, error);
      this.config.onError(error);
      throw error;
    }
    if (this.closed) return;
    log.info(`Cloud ${kind.toUpperCase()} session ${this.sessionId} extended`);
    this.config.onExtended(this.token);
    this.schedule();
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
