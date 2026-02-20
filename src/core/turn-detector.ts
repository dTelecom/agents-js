import { createLogger } from '../utils/logger';

const log = createLogger('TurnDetector');

export interface TurnDetectorOptions {
  /** Silence duration after final transcription before triggering (default: 800ms) */
  silenceTimeoutMs?: number;
}

export class TurnDetector {
  private readonly silenceTimeoutMs: number;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private _onTurnEnd: (() => void) | null = null;
  private lastFinalText = '';

  constructor(options: TurnDetectorOptions = {}) {
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? 800;
  }

  /** Set the callback for when a turn ends */
  set onTurnEnd(cb: (() => void) | null) {
    this._onTurnEnd = cb;
  }

  /**
   * Feed a transcription result.
   * Returns true if this result represents a completed turn.
   */
  handleTranscription(text: string, isFinal: boolean): boolean {
    this.clearTimer();

    if (isFinal && text.trim().length > 0) {
      this.lastFinalText = text;

      // Start silence timer — if no new speech, the turn is done
      this.silenceTimer = setTimeout(() => {
        log.debug(`Turn ended after ${this.silenceTimeoutMs}ms silence`);
        this._onTurnEnd?.();
      }, this.silenceTimeoutMs);

      return false;
    }

    if (!isFinal && text.trim().length > 0) {
      // Interim result — user is still speaking, reset timer
      this.clearTimer();
    }

    return false;
  }

  /** Force-trigger turn end */
  forceTurnEnd(): void {
    this.clearTimer();
    this._onTurnEnd?.();
  }

  /** Reset state */
  reset(): void {
    this.clearTimer();
    this.lastFinalText = '';
  }

  private clearTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
