import { createLogger } from '../utils/logger';

const log = createLogger('BargeIn');

export class BargeIn {
  private abortController: AbortController | null = null;
  private _interrupted = false;
  private _onInterrupt: (() => void) | null = null;

  get interrupted(): boolean {
    return this._interrupted;
  }

  /** Set the callback for when barge-in occurs */
  set onInterrupt(cb: (() => void) | null) {
    this._onInterrupt = cb;
  }

  /**
   * Create a new AbortController for the current response cycle.
   * Call this at the start of each STT->LLM->TTS cycle.
   */
  startCycle(): AbortSignal {
    this.abortController = new AbortController();
    this._interrupted = false;
    return this.abortController.signal;
  }

  /** Trigger barge-in. Called when STT detects speech during agent output. */
  trigger(): void {
    if (this._interrupted) return;
    this._interrupted = true;

    log.info('Barge-in detected — cancelling current response');

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this._onInterrupt?.();
  }

  /** Reset after the interrupted cycle is cleaned up */
  reset(): void {
    this._interrupted = false;
    this.abortController = null;
  }
}
