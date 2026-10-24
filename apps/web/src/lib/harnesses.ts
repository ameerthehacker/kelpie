/** The harnesses Kelpie knows by name; any other shows by its id. */
export const HARNESSES: Record<string, { name: string; mark: string }> = {
  'claude-code': { name: 'Claude Code', mark: 'CC' },
  codex: { name: 'Codex', mark: 'CX' },
};

export const harnessOf = (h: string) => HARNESSES[h] ?? { name: h, mark: h.slice(0, 2).toUpperCase() };
