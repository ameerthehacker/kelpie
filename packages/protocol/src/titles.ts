import { z } from 'zod';

/**
 * Where a round-up's title came from: its first message (cut short), a title Claude generated once
 * the conversation started, or the person renaming it. The person's title is never replaced; a
 * person clearing theirs lets AI titles resume.
 */
export const SessionTitleSource = z.enum(['message', 'ai', 'person']);
export type SessionTitleSource = z.infer<typeof SessionTitleSource>;
