/** Retain only suffixes that may become a secret when the next chunk arrives. */
export class Redactor {
  private pending = '';
  constructor(private secrets: () => string[]) {}
  push(chunk: string): string {
    let text = this.pending + chunk;
    const secrets = this.secrets()
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    let hold = 0;
    for (const secret of secrets)
      for (let n = 1; n < secret.length && n <= text.length; n++)
        if (text.endsWith(secret.slice(0, n))) hold = Math.max(hold, n);
    this.pending = hold ? text.slice(-hold) : '';
    return hold ? text.slice(0, -hold) : text;
  }
  flush() {
    const result = this.pending;
    this.pending = '';
    return result;
  }
}
