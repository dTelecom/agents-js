export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** Default to 'debug' if DEBUG env var matches our namespace */
function detectLevel(): LogLevel {
  const debug = typeof process !== 'undefined' && process.env?.DEBUG;
  if (debug && (debug === '*' || debug.includes('@dtelecom/agents'))) {
    return 'debug';
  }
  return 'info';
}

let globalLevel: LogLevel = detectLevel();

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function timestamp(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

export function createLogger(tag: string): Logger {
  const prefix = `[@dtelecom/agents:${tag}]`;
  return {
    debug(...args: unknown[]) {
      if (LEVELS[globalLevel] <= LEVELS.debug) console.debug(timestamp(), prefix, ...args);
    },
    info(...args: unknown[]) {
      if (LEVELS[globalLevel] <= LEVELS.info) console.info(timestamp(), prefix, ...args);
    },
    warn(...args: unknown[]) {
      if (LEVELS[globalLevel] <= LEVELS.warn) console.warn(timestamp(), prefix, ...args);
    },
    error(...args: unknown[]) {
      if (LEVELS[globalLevel] <= LEVELS.error) console.error(timestamp(), prefix, ...args);
    },
  };
}
