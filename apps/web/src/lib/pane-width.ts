/** The agent pane's width beside the chat on a wide screen, in pixels. */
export const PANE_DEFAULT = 470;
export const PANE_MIN = 360;
/** Of the room the chat and the pane share. */
export const PANE_MAX_SHARE = 0.7;
/** The chat keeps at least this much, whatever the pane is dragged to. */
export const CHAT_MIN = 420;

const KEY = 'kelpie.pane-width';

/**
 * The pane's narrowest and widest, given the room the chat and the pane share. The chat's
 * minimum wins when there isn't room for both: the pane's range shrinks to what is left.
 */
export function paneLimits(room: number): { min: number; max: number } {
  const max = Math.max(0, Math.min(room * PANE_MAX_SHARE, room - CHAT_MIN));
  return { min: Math.min(PANE_MIN, max), max };
}

/** `width` within the pane's limits; with no room measured yet, only kept above its minimum. */
export function clampPaneWidth(width: number, room?: number): number {
  const { min, max } = room === undefined ? { min: PANE_MIN, max: Infinity } : paneLimits(room);
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** The width the person left the pane at, or the default. */
export function loadPaneWidth(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): number {
  try {
    const saved = Number(storage?.getItem(KEY) ?? NaN);
    return Number.isFinite(saved) && saved > 0 ? clampPaneWidth(saved) : PANE_DEFAULT;
  } catch {
    return PANE_DEFAULT;
  }
}

/** Remembers `width`; the default is remembered as nothing, so a later default applies. */
export function savePaneWidth(width: number, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage) {
  try {
    const w = clampPaneWidth(width);
    if (w === PANE_DEFAULT) storage?.removeItem(KEY);
    else storage?.setItem(KEY, String(w));
  } catch {}
}
