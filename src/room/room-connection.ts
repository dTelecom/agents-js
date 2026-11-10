import { Room, LocalAudioTrack, AudioSource, TrackSource } from '@dtelecom/server-sdk-node';
import type { CloudClient } from '@dtelecom/server-sdk-js';
import { createLogger } from '../utils/logger';

const log = createLogger('RoomConnection');

export interface RoomConnectionOptions {
  room: string;
  identity?: string;
  name?: string;

  // Mode 1: dTelecom Cloud — the cloud mints the agent's token
  cloud?: CloudClient;
  /** Cloud mode: the agent's session lifetime, e.g. '6h' (default 6 hours, at most 24). */
  ttl?: number | string;

  // Mode 2: dTelecom Cloud API key and secret; builds a CloudClient (base URL from DTELECOM_CLOUD_URL)
  apiKey?: string;
  apiSecret?: string;

  // Mode 3: Use pre-signed token from x402 gateway
  token?: string;
  wsUrl?: string;
}

export class RoomConnection {
  readonly room: Room;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private _connected = false;
  /** Cloud mode: the agent's WebRTC session id, which links its speech sessions to the room. */
  webrtcSessionId: string | null = null;

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

    if (options.token && options.wsUrl) {
      // Mode 3: Use pre-signed token from x402 gateway
      jwt = options.token;
      wsUrl = options.wsUrl;
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
      this.webrtcSessionId = issued.sessionId;
    } else {
      throw new Error('Either cloud, (apiKey + apiSecret) or (token + wsUrl) must be provided');
    }

    log.info(`SFU URL: ${wsUrl}`);

    // Connect
    await this.room.connect(wsUrl, jwt, { autoSubscribe: true });
    this._connected = true;

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

  /** Disconnect from the room and clean up resources. */
  async disconnect(): Promise<void> {
    if (!this._connected) return;

    if (this.localTrack) {
      await this.room.localParticipant.unpublishTrack(this.localTrack);
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
