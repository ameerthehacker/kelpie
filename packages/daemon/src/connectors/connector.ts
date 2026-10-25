/** Who a connection acts as on its service. */
export interface ConnectionAccount {
  login: string;
  name?: string;
  avatarUrl?: string;
  url?: string;
}

/** A connector as the settings page shows it. Never carries the secret. */
export interface ConnectionStatus {
  id: string;
  name: string;
  /** A credential is there and was not refused when last checked. */
  connected: boolean;
  /** Where the credential comes from, e.g. `gh` (read from the gh CLI) or `token` (pasted, stored by Kelpie). */
  method?: string;
  account?: ConnectionAccount;
  /** What the credential may do; null when the service doesn't say (e.g. a fine-grained token). */
  scopes?: string[] | null;
  /** Why it isn't working, or couldn't be checked: an expired token, a network failure. */
  error?: string;
  /** The service's own CLI, when the connector can borrow its login. */
  cli?: { name: string; installed: boolean; loggedIn: boolean };
  checkedAt: number;
}

/** What the person gave that can't be used; the message is for them. */
export class ConnectError extends Error {}

/** A service Kelpie can connect to, and hand to the agents it starts. */
export interface Connector {
  id: string;
  name: string;
  /** Looks at the service now. Never throws: problems go in `error`. */
  check(): Promise<ConnectionStatus>;
  /** Checks and stores what the person gave (a token); throws ConnectError when it won't do. */
  connect(input: { token?: unknown }): Promise<ConnectionStatus>;
  /** Forgets what Kelpie stored; a login it only borrows stays with its owner. */
  disconnect(): Promise<ConnectionStatus>;
  /** Env for the agents Kelpie starts while it is connected, read fresh each time. Never throws. */
  env(): Promise<Record<string, string>>;
}

/** A status older than this is checked again when asked for. */
const FRESH_MS = 5 * 60 * 1000;

/** Every connector Kelpie has, with what each last reported. */
export class Connections {
  private readonly byId: Map<string, Connector>;
  private readonly last = new Map<string, ConnectionStatus>();

  constructor(connectors: Connector[]) {
    this.byId = new Map(connectors.map((c) => [c.id, c]));
  }

  get(id: string): Connector | undefined {
    return this.byId.get(id);
  }

  /** Each connector's status, checked again when it was never checked or not lately. */
  list(now = Date.now()): Promise<ConnectionStatus[]> {
    return Promise.all(
      [...this.byId.values()].map((c) => {
        const last = this.last.get(c.id);
        return last && now - last.checkedAt < FRESH_MS ? last : this.check(c.id);
      }),
    );
  }

  check(id: string): Promise<ConnectionStatus> {
    return this.track(id, (c) => c.check());
  }

  connect(id: string, input: { token?: unknown }): Promise<ConnectionStatus> {
    return this.track(id, (c) => c.connect(input));
  }

  disconnect(id: string): Promise<ConnectionStatus> {
    return this.track(id, (c) => c.disconnect());
  }

  /** What every connected service gives an agent (e.g. GH_TOKEN). One that fails gives nothing. */
  async env(): Promise<Record<string, string>> {
    const envs = await Promise.all([...this.byId.values()].map((c) => c.env().catch(() => ({}))));
    return Object.assign({}, ...envs);
  }

  private async track(id: string, fn: (c: Connector) => Promise<ConnectionStatus>): Promise<ConnectionStatus> {
    const c = this.byId.get(id);
    if (!c) throw new Error(`no connector "${id}"`);
    const status = await fn(c);
    this.last.set(id, status);
    return status;
  }
}
