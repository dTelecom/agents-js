import { Room, LocalAudioTrack, AudioSource, TrackSource } from '@dtelecom/server-sdk-node';
import { createLogger } from '../utils/logger';

const log = createLogger('RoomConnection');

export interface RoomConnectionOptions {
  room: string;
  identity?: string;
  name?: string;

  // Mode 1: Generate token from credentials (existing)
  apiKey?: string;
  apiSecret?: string;

  // Mode 2: Use pre-signed token from x402 gateway
  token?: string;
  wsUrl?: string;
}

export class RoomConnection {
  readonly room: Room;
  private audioSource: AudioSource | null = null;
  private localTrack: LocalAudioTrack | null = null;
  private _connected = false;

  constructor() {
    this.room = new Room();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to a dTelecom room.
   *
   * 1. Create an Ed25519 JWT via AccessToken
   * 2. Discover nearest SFU via getWsUrl()
   * 3. Connect Room via WebRTC
   * 4. Publish an audio track for the agent to speak through
   */
  async connect(options: RoomConnectionOptions): Promise<void> {
    const { room: roomName, identity = 'agent', name } = options;

    log.info(`Connecting to room "${roomName}" as "${identity}"...`);

    let jwt: string;
    let wsUrl: string;

    if (options.token && options.wsUrl) {
      // Mode 2: Use pre-signed token from x402 gateway
      jwt = options.token;
      wsUrl = options.wsUrl;
    } else if (options.apiKey && options.apiSecret) {
      // Mode 1: Generate token from credentials
      const { AccessToken } = await import('@dtelecom/server-sdk-js');

      const token = new AccessToken(options.apiKey, options.apiSecret, {
        identity,
        name: name ?? identity,
      });
      token.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      });

      wsUrl = await token.getWsUrl();
      jwt = token.toJwt();
    } else {
      throw new Error('Either (apiKey + apiSecret) or (token + wsUrl) must be provided');
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
