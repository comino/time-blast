/**
 * Raw model text → SQL, incrementally. TypeScript twin of crates/inference-server/src/sql.rs.
 * SqlStream strips a leading <think>…</think> block and Markdown fences, holds back trailing
 * whitespace/`;`/backticks, and streams nothing until the first word looks like a query, so
 * concatenated deltas are always a prefix of finish(). check() only rejects what is obviously
 * not one SELECT; the database node does the real validation.
 */
const FENCE = '```';
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export class SqlStream {
  private raw = '';
  private emitted = 0;
  private started: boolean | undefined;

  /** Feed raw model text; returns newly certain SQL text, or undefined. */
  push(text: string): string | undefined {
    this.raw += text;
    const body = extract(this.raw, false);
    if (body === undefined) return undefined;
    const ready = body.replace(/[\s;`]+$/, '');
    if (this.started === undefined) this.started = startsLikeQuery(ready);
    if (this.started !== true || ready.length <= this.emitted) return undefined;
    const delta = ready.slice(this.emitted);
    this.emitted = ready.length;
    return delta;
  }

  finish(): string {
    return (extract(this.raw, true) ?? '').replace(/[\s;]+$/, '');
  }
}

function extract(raw: string, done: boolean): string | undefined {
  let text = raw.trimStart();
  if (text.startsWith(THINK_OPEN)) {
    const end = text.indexOf(THINK_CLOSE);
    if (end < 0) return undefined;
    text = text.slice(end + THINK_CLOSE.length).trimStart();
  } else if (!done && text !== '' && THINK_OPEN.startsWith(text)) {
    return undefined;
  }
  if (text.startsWith(FENCE)) {
    const newline = text.indexOf('\n');
    if (newline < 0) return done ? '' : undefined;
    text = text.slice(newline + 1).trimStart();
  } else if (!done && FENCE.startsWith(text)) {
    return undefined;
  }
  const close = text.indexOf(FENCE);
  if (close >= 0) text = text.slice(0, close);
  return text.trimStart();
}

const isQueryStart = (word: string): boolean => ['SELECT', 'WITH', 'FROM', '('].includes(word.toUpperCase());

function startsLikeQuery(ready: string): boolean | undefined {
  const lexer = new Lexer(ready);
  if (!lexer.skipTrivia() || lexer.unterminated) return undefined;
  const word = lexer.nextWord();
  if (word === undefined) return undefined;
  if (lexer.at === ready.length && word !== '(') return undefined;
  return isQueryStart(word);
}

/** Rejects replies that are obviously not one SELECT. Returns the reason, or undefined. */
export function check(sql: string): string | undefined {
  const lexer = new Lexer(sql);
  const first = lexer.nextWord();
  if (first === undefined) return 'the reply contained no SQL';
  if (!isQueryStart(first)) return `the reply must start with SELECT or WITH, not ${JSON.stringify(Array.from(first).slice(0, 24).join(''))}`;
  if (lexer.restHasSemicolon()) return 'the reply contained more than one statement';
  if (lexer.unterminated) return 'the reply ended inside a string, identifier or comment';
  return undefined;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isWord = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

class Lexer {
  at = 0;
  unterminated = false;
  constructor(private readonly src: string) {}

  skipTrivia(): boolean {
    for (;;) {
      while (this.at < this.src.length && isSpace(this.src[this.at])) this.at++;
      if (this.src.startsWith('--', this.at)) {
        const n = this.src.indexOf('\n', this.at);
        this.at = n < 0 ? this.src.length : n;
      } else if (this.src.startsWith('/*', this.at)) {
        const n = this.src.indexOf('*/', this.at + 2);
        if (n < 0) { this.unterminated = true; this.at = this.src.length; } else this.at = n + 2;
      } else {
        return this.at < this.src.length;
      }
    }
  }

  nextWord(): string | undefined {
    if (!this.skipTrivia()) return undefined;
    const start = this.at;
    if (this.src[start] === '(') { this.at++; return '('; }
    while (this.at < this.src.length && isWord(this.src[this.at])) this.at++;
    if (this.at === start) this.at += String.fromCodePoint(this.src.codePointAt(start)!).length;
    return this.src.slice(start, this.at);
  }

  restHasSemicolon(): boolean {
    while (this.skipTrivia()) {
      const c = this.src[this.at];
      if (c === "'" || c === '"' || c === '`') this.skipQuoted(c);
      else if (c === ';') { this.at++; if (this.skipTrivia()) return true; }
      else this.at++;
    }
    return false;
  }

  private skipQuoted(quote: string): void {
    this.at++;
    while (this.at < this.src.length) {
      if (this.src[this.at] === quote) {
        if (this.src[this.at + 1] === quote) { this.at += 2; continue; }
        this.at++;
        return;
      }
      if (this.src[this.at] === '\\' && quote === "'") this.at++;
      this.at++;
    }
    this.unterminated = true;
  }
}
