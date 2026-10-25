/** A refusal the orchestrator (or an agent) should read and act on (not a Kelpie bug). */
export class ToolError extends Error {}

/** A review request Kelpie refuses: `status` is the HTTP status it answers with. */
export class ReviewError extends ToolError {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    /** The line commented on has changed since the person saw it. */
    readonly stale = false,
  ) {
    super(message);
  }
}
