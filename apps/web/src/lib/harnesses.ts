/** The harnesses Kelpie knows by name; any other shows by its id. */
export const HARNESSES: Record<string, { name: string; mark: string }> = {
  'claude-code': { name: 'Claude Code', mark: 'CC' },
  codex: { name: 'Codex', mark: 'CX' },
};

export const harnessOf = (h: string) => HARNESSES[h] ?? { name: h, mark: h.slice(0, 2).toUpperCase() };

/** A model id as people say it: `claude-opus-5-5` → "Opus 5.5"; aliases capitalised; anything else as is. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  return /^[a-z]+$/.test(model) ? `${model[0]!.toUpperCase()}${model.slice(1)}` : model;
}
