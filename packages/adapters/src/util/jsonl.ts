/** Splits a stream of text chunks into complete lines; a partial trailing line waits for the next chunk. */
export class LineSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop()!;
    return parts.map(stripCr).filter((l) => l.trim().length > 0);
  }

  /** Returns whatever is left once the stream has ended. */
  flush(): string[] {
    const rest = stripCr(this.buf);
    this.buf = '';
    return rest.trim() ? [rest] : [];
  }
}

const stripCr = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
