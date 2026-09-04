/**
 * Lightweight diagnostics channel for non-fatal runtime warnings (backlogs, misuse).
 * Subscribe with onWarning(); without subscribers each distinct warning is logged once via console.warn.
 */
export interface Warning {
  /** Stable machine-readable code, e.g. 'event-backlog'. */
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

export type WarningHandler = (warning: Warning) => void;

const handlers = new Set<WarningHandler>();
const seen = new Set<string>();

/** Subscribes to library warnings. Returns an unsubscribe. */
export function onWarning(handler: WarningHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** @internal */
export function warn(code: string, message: string, detail: Record<string, unknown> = {}): void {
  const w: Warning = { code, message, detail };
  if (handlers.size > 0) {
    for (const h of handlers) h(w);
    return;
  }
  const key = `${code}:${JSON.stringify(detail)}`;
  if (seen.has(key)) return;
  seen.add(key);
  // oxlint-disable-next-line no-console
  console.warn(`[nursery] ${message}`, detail);
}
