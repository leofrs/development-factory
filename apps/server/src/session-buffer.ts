import type * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type {
  BackgroundSessionHistoryState,
  BackgroundSessionMode,
  BackgroundSessionStatus,
  BackgroundSessionSummary,
} from '@development-factory/shared';
import type { createReviewHistory } from './history.js';

export const DEFAULT_SESSION_BUFFER_MAX_BYTES = 256 * 1024;

interface BufferChunk {
  readonly text: string;
  readonly bytes: number;
}

/**
 * Recorta a cauda de uma string UTF-8 para caber em `maxBytes` sem partir
 * caracteres multibyte no início do trecho resultante.
 */
function trimUtf8TailToMaxBytes(value: string, maxBytes: number): { text: string; bytes: number } {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length <= maxBytes) {
    return { text: value, bytes: encoded.length };
  }

  let start = encoded.length - maxBytes;
  // Avança bytes de continuação UTF-8 (10xxxxxx) para alinhar no próximo caractere válido.
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  const tail = encoded.subarray(start);
  return { text: tail.toString('utf8'), bytes: tail.length };
}

/**
 * Ring buffer em memória com teto configurável em bytes para chunks de saída PTY.
 * Descarta os chunks mais antigos quando o limite é ultrapassado, preservando
 * a leitura sequencial para replay no xterm.js.
 */
export class SessionOutputBuffer {
  readonly #maxBytes: number;
  #chunks: BufferChunk[] = [];
  #head = 0;
  #byteLength = 0;
  #truncated = false;

  constructor(maxBytes: number = DEFAULT_SESSION_BUFFER_MAX_BYTES) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes deve ser um inteiro positivo.');
    }
    this.#maxBytes = maxBytes;
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }

    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (chunkBytes > this.#maxBytes) {
      this.#chunks = [];
      this.#head = 0;
      this.#byteLength = 0;
      this.#truncated = true;

      const trimmed = trimUtf8TailToMaxBytes(chunk, this.#maxBytes);
      if (trimmed.bytes > 0) {
        this.#chunks.push(trimmed);
        this.#byteLength = trimmed.bytes;
      }
      return;
    }

    this.#chunks.push({ text: chunk, bytes: chunkBytes });
    this.#byteLength += chunkBytes;

    while (this.#byteLength > this.#maxBytes && this.#head < this.#chunks.length) {
      const oldest = this.#chunks[this.#head];
      if (oldest === undefined) {
        break;
      }
      this.#head += 1;
      this.#byteLength -= oldest.bytes;
      this.#truncated = true;
    }

    if (this.#head > 64 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  replay(): string {
    if (this.#head >= this.#chunks.length) {
      return '';
    }

    const parts: string[] = [];
    for (let index = this.#head; index < this.#chunks.length; index += 1) {
      const chunk = this.#chunks[index];
      if (chunk !== undefined) {
        parts.push(chunk.text);
      }
    }
    return parts.join('');
  }

  clear(): void {
    this.#chunks = [];
    this.#head = 0;
    this.#byteLength = 0;
    this.#truncated = false;
  }
}

export type SessionHistoryHandle = ReturnType<typeof createReviewHistory>;

export interface ActiveReviewSession {
  readonly reviewId: string;
  readonly executionId: string;
  readonly reportArtifactId: string;
  readonly sessionArtifactId: string;
  reportSaved: boolean;
}

export interface ManagedSession {
  readonly sessionId: string;
  readonly mode: BackgroundSessionMode;
  readonly title: string;
  readonly repoPath: string;
  status: BackgroundSessionStatus;
  historyState: BackgroundSessionHistoryState;
  reportPath: string | null;
  sessionPath: string | null;
  ptyProcess: pty.IPty | undefined;
  subscriptions: pty.IDisposable[];
  history: SessionHistoryHandle | undefined;
  activeReviewSession: ActiveReviewSession | undefined;
  readonly subscribers: Set<WebSocket>;
  readonly buffer: SessionOutputBuffer;
  readonly startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: number | string | null;
  error: string | null;
}

export function toBackgroundSessionSummary(session: ManagedSession): BackgroundSessionSummary {
  return {
    sessionId: session.sessionId,
    mode: session.mode,
    title: session.title,
    repoPath: session.repoPath,
    status: session.status,
    historyState: session.historyState,
    reportPath: session.history?.reportPath ?? session.reportPath,
    sessionPath: session.history?.sessionPath ?? session.sessionPath,
    reviewId: session.activeReviewSession?.reviewId ?? null,
    executionId: session.activeReviewSession?.executionId ?? null,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    exitCode: session.exitCode,
    error: session.error,
  };
}
