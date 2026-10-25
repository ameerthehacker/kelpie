import { useEffect, useRef, useState } from 'react';

/**
 * `value`, but each one shown stays up at least `minMs`: quick changes in between are skipped,
 * and whatever is latest when the time is up shows next. For live labels that would flicker.
 */
export function useSteady<T>(value: T, minMs: number): T {
  const [shown, setShown] = useState(value);
  const since = useRef(0);
  useEffect(() => {
    if (!since.current) since.current = Date.now();
  }, []);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const timer = setTimeout(
      () => {
        since.current = Date.now();
        setShown(value);
      },
      Math.max(0, since.current + minMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value, shown, minMs]);
  return shown;
}
