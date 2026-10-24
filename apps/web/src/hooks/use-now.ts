import { useEffect, useState } from 'react';

/** The current time, re-rendering every `every` ms, for "5 minutes ago" and "resets in" texts. */
export function useNow(every = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}
