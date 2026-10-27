/** The agent pane's width beside the chat on a wide screen, in pixels. */
export const PANE_DEFAULT = 470;
export const PANE_MIN = 360;
/** Of the room the chat and the pane share. */
export const PANE_MAX_SHARE = 0.7;
/** The chat keeps at least this much, whatever the pane is dragged to. */
export const CHAT_MIN = 420;

const KEY = 'kelpie.pane-width';

type Get = Pick<Storage, 'getItem'>;
type Set = Pick<Storage, 'setItem' | 'removeItem'>;

/** A width to remember: whole pixels, and never under the pane's minimum (its maximum depends on the window). */
export const clampPaneWidth = (width: number) => Math.round(Math.max(PANE_MIN, width));

/** The width the person left the pane at, or the default. `storage` defaults to localStorage, which may refuse to be read at all. */
export function loadPaneWidth(storage?: Get): number {
  try {
    const saved = Number((storage ?? localStorage).getItem(KEY) ?? NaN);
    return Number.isFinite(saved) && saved > 0 ? clampPaneWidth(saved) : PANE_DEFAULT;
  } catch {
    return PANE_DEFAULT;
  }
}

/** Remembers `width`; the default is remembered as nothing, so a later default applies. */
export function savePaneWidth(width: number, storage?: Set) {
  try {
    const w = clampPaneWidth(width);
    if (w === PANE_DEFAULT) (storage ?? localStorage).removeItem(KEY);
    else (storage ?? localStorage).setItem(KEY, String(w));
  } catch {}
}
