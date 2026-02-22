/**
 * VoiceAgent — top-level orchestrator for AI voice agents in dTelecom rooms.
 *
 * Wires together:
 * - RoomConnection (join room, publish audio track)
 * - Pipeline (STT -> LLM -> TTS)
 * - AudioInput (per-participant audio streams)
 * - AudioOutput (agent's published audio)
 * - RoomMemory (optional persistent memory)
 */

import { EventEmitter } from 'events';
import type { RemoteAudioTrack, RemoteTrackPublication, RemoteParticipant } from '@dtelecom/server-sdk-node';
import { RoomConnection } from '../room/room-connection';
import { AudioInput } from '../room/audio-input';
import { AudioOutput } from '../room/audio-output';
import { Pipeline } from './pipeline';
import type { AgentConfig, AgentStartOptions, DataMessageHandler } from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('VoiceAgent');

export class VoiceAgent extends EventEmitter {
  private readonly config: AgentConfig;
  private connection: RoomConnection | null = null;
  private pipeline: Pipeline | null = null;
  private audioInputs = new Map<string, AudioInput>();
  private audioOutput: AudioOutput | null = null;
  private memory: import('../memory/room-memory').RoomMemory | null = null;
  private _running = false;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
  }

  get running(): boolean {
    return this._running;
  }

  get room() { return this.connection?.room ?? null; }

  /** Enable saving raw TTS audio as WAV files to `dir` for debugging. */
  enableAudioDump(dir: string): void {
    this._dumpDir = dir;
    if (this.audioOutput) {
      this.audioOutput.dumpDir = dir;
    }
  }
  private _dumpDir: string | null = null;

  /**
   * Speak text directly via TTS, bypassing the LLM.
   * Use for greetings or announcements. Supports barge-in.
   */
  async say(text: string): Promise<void> {
    if (!this.pipeline) {
      throw new Error('Agent not started — call start() first');
    }
    await this.pipeline.say(text);
  }

  /** Start the agent — connect to room and begin listening. */
  async start(options: AgentStartOptions): Promise<void> {
    if (this._running) {
      throw new Error('Agent is already running');
    }

    log.info(`Starting agent for room "${options.room}"...`);

    // 1. Initialize memory (if enabled)
    if (this.config.memory?.enabled) {
      const { RoomMemory } = await import('../memory/room-memory');
      this.memory = new RoomMemory({
        dbPath: this.config.memory.dbPath ?? './data/memory.db',
        room: options.room,
      });
      await this.memory.init();
      this.memory.startSession();
      log.info('Memory initialized');
    }

    // 2. Connect to room
    this.connection = new RoomConnection();
    await this.connection.connect({
      room: options.room,
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      identity: options.identity ?? 'agent',
      name: options.name ?? options.identity ?? 'AI Agent',
    });

    // 3. Publish audio track + start sending silence to keep it active
    const source = await this.connection.publishAudioTrack();
    this.audioOutput = new AudioOutput(source);
    if (this._dumpDir) this.audioOutput.dumpDir = this._dumpDir;
    this.audioOutput.startSilence();

    // 4. Create pipeline (warmup is handled internally by Pipeline)
    this.pipeline = new Pipeline({
      stt: this.config.stt,
      llm: this.config.llm,
      tts: this.config.tts,
      instructions: this.config.instructions,
      audioOutput: this.audioOutput,
      respondMode: this.config.respondMode,
      agentName: this.config.agentName,
      nameVariants: this.config.nameVariants,
      memory: this.memory ?? undefined,
      maxContextTokens: this.config.maxContextTokens,
    });

    // Forward pipeline events
    this.pipeline.on('transcription', (result) => this.emit('transcription', result));
    this.pipeline.on('sentence', (text) => this.emit('sentence', text));
    this.pipeline.on('response', (text) => this.emit('response', text));
    this.pipeline.on('agentState', (state) => this.emit('agentState', state));
    this.pipeline.on('error', (error) => this.emit('error', error));

    // 5. Subscribe to existing remote participants
    for (const participant of this.connection.room.remoteParticipants.values()) {
      for (const [, pub] of participant.trackPublications) {
        if (pub.track) {
          this.handleTrackSubscribed(pub.track as RemoteAudioTrack, pub as RemoteTrackPublication, participant);
        }
      }
    }

    // 6. Listen for new tracks
    this.connection.room.on('trackSubscribed', (track, pub, participant) => {
      this.handleTrackSubscribed(track, pub, participant);
    });

    this.connection.room.on('trackUnsubscribed', (track, _pub, participant) => {
      this.handleTrackUnsubscribed(track, participant);
    });

    this.connection.room.on('participantDisconnected', (participant) => {
      this.handleParticipantDisconnected(participant);
    });

    this.connection.room.on('disconnected', (reason) => {
      log.info(`Room disconnected: ${reason}`);
      this.emit('disconnected', reason);
    });

    // 7. Data channel support
    if (this.config.onDataMessage) {
      this.setupDataChannel(this.config.onDataMessage);
    }

    this._running = true;
    this.emit('connected');
    log.info('Agent started and listening');
  }

  /** Stop the agent — disconnect and clean up. */
  async stop(): Promise<void> {
    if (!this._running) return;

    log.info('Stopping agent...');
    this._running = false;

    if (this.pipeline) {
      await this.pipeline.stop();
      this.pipeline = null;
    }

    // End memory session (generates summary)
    if (this.memory) {
      try {
        await this.memory.endSession(this.config.llm);
        await this.memory.close();
      } catch (err) {
        log.error('Error closing memory:', err);
      }
      this.memory = null;
    }

    for (const [, input] of this.audioInputs) {
      input.close();
    }
    this.audioInputs.clear();

    if (this.audioOutput) {
      this.audioOutput.stop();
      this.audioOutput = null;
    }

    if (this.connection) {
      await this.connection.disconnect();
      this.connection = null;
    }

    this.emit('disconnected', 'agent_stopped');
    log.info('Agent stopped');
  }

  private setupDataChannel(handler: DataMessageHandler): void {
    if (!this.connection) return;

    this.connection.room.on('dataReceived', (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      const identity = participant?.identity ?? 'unknown';
      handler(payload, identity, topic);
    });

    log.info('Data channel handler registered');
  }

  private handleTrackSubscribed(
    track: RemoteAudioTrack,
    _publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ): void {
    const identity = participant.identity;
    log.info(`Track subscribed from "${identity}" (sid=${track.sid})`);

    // Track participant in memory
    this.memory?.addParticipant(identity);

    // Close existing AudioInput if this is a re-subscription
    const existing = this.audioInputs.get(identity);
    if (existing) {
      log.info(`Closing old AudioInput for "${identity}" (re-subscription)`);
      existing.close();
    }

    const audioInput = new AudioInput(track, identity);
    this.audioInputs.set(identity, audioInput);

    const sttStream = this.pipeline!.addParticipant(identity);

    this.pipeAudioToSTT(audioInput, sttStream, identity);
  }

  private handleTrackUnsubscribed(
    _track: RemoteAudioTrack,
    participant: RemoteParticipant,
  ): void {
    const identity = participant.identity;
    log.info(`Track unsubscribed from "${identity}"`);

    const input = this.audioInputs.get(identity);
    if (input) {
      input.close();
      this.audioInputs.delete(identity);
    }
  }

  private handleParticipantDisconnected(participant: RemoteParticipant): void {
    const identity = participant.identity;
    log.info(`Participant disconnected: "${identity}"`);

    const input = this.audioInputs.get(identity);
    if (input) {
      input.close();
      this.audioInputs.delete(identity);
    }

    this.pipeline?.removeParticipant(identity);
  }

  private async pipeAudioToSTT(
    input: AudioInput,
    sttStream: { sendAudio(pcm16: Buffer): void },
    identity: string,
  ): Promise<void> {
    try {
      for await (const buffer of input.frames()) {
        if (!this._running) break;
        sttStream.sendAudio(buffer);
      }
    } catch (err) {
      if (this._running) {
        log.error(`Audio pipe error for "${identity}":`, err);
      }
    }
  }
}
