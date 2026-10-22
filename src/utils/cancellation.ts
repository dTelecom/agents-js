/** Only suppress provider abort errors when this operation was actually cancelled. */
export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted && (
    error === signal.reason ||
    error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  );
}

/** Cancel waiting for shared warmup/read-only work without leaving rejection handlers behind. */
export function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
