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

export interface SignalLink {
  signal: AbortSignal;
  /** Detach from the inputs. No-op for the native implementation, which is GC-safe. */
  unlink: () => void;
}

/**
 * Manual fallback for AbortSignal.any. Unlike the native version, it holds strong listeners
 * on the inputs, so call `unlink()` when the derived signal is no longer needed.
 */
export function manualAnySignal(signals: readonly MaybeSignal[]): SignalLink {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  const ctrl = new AbortController();
  const detach = () => {
    for (const s of list) s.removeEventListener('abort', onAbort);
  };
  const onAbort = function (this: AbortSignal) {
    ctrl.abort(this.reason);
    detach();
  };
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return { signal: ctrl.signal, unlink: () => {} };
    }
  }
  for (const s of list) s.addEventListener('abort', onAbort);
  return { signal: ctrl.signal, unlink: detach };
}

/**
 * A signal that aborts as soon as any input aborts, carrying its reason, plus `unlink()`
 * for callers that own a long-lived parent signal and want to drop the link explicitly.
 */
export function linkSignals(signals: readonly MaybeSignal[]): SignalLink {
  const nativeAny = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (nativeAny) {
    const list = signals.filter((s): s is AbortSignal => s !== undefined);
    return { signal: nativeAny.call(AbortSignal, list), unlink: () => {} };
  }
  return manualAnySignal(signals);
}

/** Shorthand for linkSignals(...).signal when the link lifetime does not matter. */
export function anySignal(signals: readonly MaybeSignal[]): AbortSignal {
  return linkSignals(signals).signal;
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
