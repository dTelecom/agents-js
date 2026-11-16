/**
 * The WebSocket address of a dTelecom speech server's authenticated stream: `/v1/stream` on the
 * server's origin. Accepts an origin (`https://stt.example`) or a full stream URL
 * (`wss://stt.example/v1/stream`, as the cloud's `stream_url`); http(s) becomes ws(s).
 */
export function toStreamUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  const path = url.pathname.replace(/\/+$/, '');
  if (!['ws:', 'wss:'].includes(url.protocol) || !['', '/v1/stream'].includes(path)) {
    throw new Error(`Invalid dTelecom speech server URL: ${serverUrl}`);
  }
  url.pathname = '/v1/stream';
  url.hash = '';
  return url.toString();
}

/** A fresh session key for a reconnect in x402 mode, where a key serves one connection. */
export interface SessionKeyRefresh {
  sessionKey: string;
  /** The server to use with it, when it changes. */
  serverUrl?: string;
}
