/** Cancellation helpers built on the native AbortSignal. */

export type MaybeSignal = AbortSignal | undefined;

/** True for DOMException AbortError / TimeoutError (the two "cancelled" reasons). */
export function isAbort(err: unknown): boolean {
  return (
    err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

export function abortError(message = 'Aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

export function timeoutError(message = 'Timed out'): DOMException {
  return new DOMException(message, 'TimeoutError');
}

/** Throws signal.reason if the signal is already aborted. */
export function throwIfAborted(signal: MaybeSignal): void {
  if (signal?.aborted) throw signal.reason ?? abortError();
}

/**
 * A signal that aborts as soon as any of the inputs aborts, carrying its reason.
 * Uses AbortSignal.any when available, otherwise a manual fallback.
 */
export function anySignal(signals: readonly MaybeSignal[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn.call(AbortSignal, list);

  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
  }
  const onAbort = function (this: AbortSignal) {
    ctrl.abort(this.reason);
    for (const s of list) s.removeEventListener('abort', onAbort);
  };
  for (const s of list) s.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}

/** A signal that aborts with TimeoutError after `ms`. */
export function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(timeoutError(`Timed out after ${ms}ms`)), ms);
  return ctrl.signal;
}

/** Cancellable delay. Rejects with the abort reason and clears the timer. */
export function sleep(ms: number, signal?: MaybeSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
