import { Room, LocalAudioTrack, AudioSource, TrackSource } from '@dtelecom/server-sdk-node';
import type { CloudClient } from '@dtelecom/server-sdk-js';
import { createLogger } from '../utils/logger';

const log = createLogger('RoomConnection');

/** Extend the agent's token this long before it expires (at most half its lifetime). */
const EXTEND_MARGIN_MS = 10 * 60_000;
/** After a failed extension that may pass (402, network), try again this often. */
const EXTEND_RETRY_MS = 15_000;
/** The cloud removes a participant a minute after an unextended token expires; stop trying before. */
const EXTEND_DEADLINE_MS = 50_000;

export interface RoomConnectionOptions {
  room: string;
  identity?: string;
  name?: string;

  // Mode 1: dTelecom Cloud — the cloud mints the agent's token
  cloud?: CloudClient;
  /**
   * Cloud mode: how long each token holds, e.g. '6h' (default 6 hours, at most 24). The agent
   * extends it by the same amount before it expires, so it stays until stop().
   */
  ttl?: number | string;
  /** Cloud mode: called when extending the agent's token fails. */
  onError?: (error: Error) => void;

  // Mode 2: dTelecom Cloud API key and secret; builds a CloudClient (base URL from DTELECOM_CLOUD_URL)
  apiKey?: string;
  apiSecret?: string;

  // Mode 3: Use pre-signed token from x402 gateway
  token?: string;
  wsUrl?: string;
  /** Ranked signaling URLs returned with a pre-signed grant. */
  fallbackUrls?: string[];
}

export class RoomConnection {
  readonly room: Room;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private _connected = false;
  /** Cloud mode: the agent's WebRTC session id, which links its speech sessions to the room. */
  webrtcSessionId: string | null = null;
  /** Cloud mode: the latest token, for a reconnect. */
  token: string | null = null;
  private cloud: CloudClient | null = null;
  private expiresAt = 0;
  private extendSeconds = 0;
  private extendTimer: ReturnType<typeof setTimeout> | null = null;
  private onError: ((error: Error) => void) | undefined;
  /** An extension failed and is being retried; the error was reported once. */
  private extendFailing = false;

  constructor() {
    this.room = new Room();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to a dTelecom room.
   *
   * 1. Get a token and node URL: from dTelecom Cloud (cloud, or apiKey + apiSecret), or the
   *    x402 gateway's pre-signed token + wsUrl
   * 2. Connect Room via WebRTC
   */
  async connect(options: RoomConnectionOptions): Promise<void> {
    const { room: roomName, identity = 'agent', name } = options;

    log.info(`Connecting to room "${roomName}" as "${identity}"...`);

    let jwt: string;
    let wsUrl: string;
    let fallbackUrls: string[] | undefined;

    if (options.token && options.wsUrl) {
      // Mode 3: Use pre-signed token from x402 gateway
      jwt = options.token;
      wsUrl = options.wsUrl;
      fallbackUrls = options.fallbackUrls;
    } else if (options.cloud || (options.apiKey && options.apiSecret)) {
      // Modes 1 and 2: dTelecom Cloud. Default grants: publish, subscribe and data.
      let cloud = options.cloud;
      if (!cloud) {
        const { CloudClient } = await import('@dtelecom/server-sdk-js');
        cloud = new CloudClient({ apiKey: options.apiKey, apiSecret: options.apiSecret });
      }
      const issued = await cloud.createToken({ room: roomName, identity, name: name ?? identity, ttl: options.ttl });
      jwt = issued.token;
      wsUrl = issued.wsUrl;
      fallbackUrls = issued.fallbackUrls;
      this.webrtcSessionId = issued.sessionId;
      this.token = issued.token;
      this.cloud = cloud;
      this.expiresAt = issued.expiresAt.getTime();
      // Each extension adds what the token was created with (the cloud rounds to whole minutes).
      this.extendSeconds = Math.max(60, Math.round((this.expiresAt - Date.now()) / 60_000) * 60);
      this.onError = options.onError;
    } else {
      throw new Error('Either cloud, (apiKey + apiSecret) or (token + wsUrl) must be provided');
    }

    log.info(`SFU URL: ${wsUrl}`);

    // Connect
    await this.room.connect(wsUrl, jwt, { autoSubscribe: true, fallbackUrls });
    this._connected = true;
    this.room.on('disconnected', () => {
      this._connected = false;
      this.stopExtending();
    });
    if (this.cloud) this.scheduleExtension();

    log.info('Connected successfully');
  }

  /**
   * Publish an audio track so the agent can speak.
   * Returns the AudioSource to feed PCM16 audio into.
   */
  async publishAudioTrack(): Promise<AudioSource> {
    if (this.audioSource) return this.audioSource;

    // 48kHz mono — matches Opus/WebRTC native rate, no resampling needed
    this.audioSource = new AudioSource(48000, 1);
    this.localTrack = LocalAudioTrack.createAudioTrack('agent-voice', this.audioSource);

    await this.room.localParticipant.publishTrack(this.localTrack, {
      name: 'agent-voice',
      source: TrackSource.MICROPHONE,
    });

    log.info('Audio track published');
    return this.audioSource;
  }

  /**
   * Cloud mode: the cloud removes a participant a minute after its token expires, so the agent
   * extends its own token before that. The node keeps the current connection; the new token is
   * kept for a reconnect.
   */
  private scheduleExtension(delayMs?: number): void {
    this.stopExtending();
    const margin = Math.min(EXTEND_MARGIN_MS, (this.extendSeconds * 1000) / 2);
    const delay = delayMs ?? Math.max(this.expiresAt - margin - Date.now(), 0);
    this.extendTimer = setTimeout(() => {
      this.extendTimer = null;
      void this.extend();
    }, delay);
    this.extendTimer.unref?.();
  }

  private stopExtending(): void {
    if (this.extendTimer) clearTimeout(this.extendTimer);
    this.extendTimer = null;
  }

  private async extend(): Promise<void> {
    if (!this.cloud || !this.webrtcSessionId || !this._connected) return;
    try {
      const extended = await this.cloud.extendToken(this.webrtcSessionId, this.extendSeconds);
      if (!this._connected) return;
      this.token = extended.token;
      this.room.updateConnectionToken(extended.token, extended.fallbackUrls);
      this.expiresAt = extended.expiresAt.getTime();
      log.info(`Agent token extended until ${extended.expiresAt.toISOString()}`);
      this.extendFailing = false;
      this.scheduleExtension();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const status = (err as { status?: number }).status;
      // 404/409: the session is gone or past its expiry; another call cannot help.
      const final = status === 404 || status === 409;
      const canRetry = !final && Date.now() + EXTEND_RETRY_MS < this.expiresAt + EXTEND_DEADLINE_MS;
      log.error(`Agent token extension failed${canRetry ? ', retrying' : ''}:`, error);
      if (!this.extendFailing || !canRetry) this.onError?.(error);
      this.extendFailing = canRetry;
      if (canRetry && this._connected) this.scheduleExtension(EXTEND_RETRY_MS);
    }
  }

  /** Disconnect from the room and clean up resources. */
  async disconnect(): Promise<void> {
    this.stopExtending();
    if (this.localTrack) {
      if (this.room.isConnected) await this.room.localParticipant.unpublishTrack(this.localTrack);
      this.localTrack = null;
    }

    if (this.audioSource) {
      this.audioSource.destroy();
      this.audioSource = null;
    }

    await this.room.disconnect();
    this._connected = false;

    log.info('Disconnected from room');
  }
}
