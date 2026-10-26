/**
 * A session paused because its harness hit the person's usage limit, as `SessionInfo.limited` and
 * an agent summary's `limited` carry it. Kelpie resumes it once the limit resets: at `retryAt`.
 */
export interface UsageLimitPause {
  /** Epoch ms it first paused. */
  since: number;
  /** Epoch ms the limit resets, when the harness said. */
  resetsAt?: number;
  /** Epoch ms Kelpie resumes it; absent when it won't on its own (the person said not to, or Kelpie gave up). */
  retryAt?: number;
  /** Tries that found the limit still in force. */
  attempts: number;
  /** The harness's own words. */
  message: string;
  /** Kelpie tried as often as it will without the limit lifting: it is the person's to resume now. */
  gaveUp?: boolean;
}
