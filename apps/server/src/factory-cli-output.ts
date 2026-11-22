import { stripVTControlCharacters } from 'node:util';
import { MAX_FACTORY_ACTIVITY_LENGTH } from '@development-factory/shared';
import type { FactorySessionActivity } from '@development-factory/shared';
import { redactSecrets } from './secret-redaction.js';

export type FactoryActivityField = keyof Omit<FactorySessionActivity, 'revision'>;
type ReportActivity = (field: FactoryActivityField, value: string) => void;
type ToolActivity = { field: FactoryActivityField; value: string };

const MAX_RECORD_LENGTH = 8 * 1024 * 1024;
const MAX_PENDING_TOOLS = 64;

export function formatFactoryActivityValue(raw: string): string {
  const sanitized = redactSecrets(stripVTControlCharacters(raw)).replace(/\p{Cc}+/gu, ' ').trim();
  if (sanitized.length <= MAX_FACTORY_ACTIVITY_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_FACTORY_ACTIVITY_LENGTH - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getToolActivity(block: Record<string, unknown>): ToolActivity | undefined {
  if (!isRecord(block.input)) {
    return undefined;
  }

  if (block.name === 'Bash' && typeof block.input.command === 'string') {
    return { field: 'lastCommand', value: formatFactoryActivityValue(block.input.command) };
  }
  if (typeof block.input.file_path !== 'string') {
    return undefined;
  }
  const value = formatFactoryActivityValue(block.input.file_path);
  if (block.name === 'Read') {
    return { field: 'lastReadFile', value };
  }
  if (block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit') {
    return { field: 'lastEditedFile', value };
  }
  return undefined;
}

/** Decodifica a saída JSONL do Claude preservando o texto do terminal e os resultados das ferramentas. */
export class FactoryCliOutput {
  #record = '';
  #discardRecord = false;
  #plainLine = false;
  #lastText: string | undefined;
  readonly #pendingTools = new Map<string, ToolActivity>();

  constructor(
    private readonly onOutput: (data: string) => void,
    private readonly onActivity: ReportActivity,
  ) {}

  append(data: string): void {
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf('\n', start);
      const end = newline === -1 ? data.length : newline + 1;
      const part = data.slice(start, end);

      if (this.#plainLine || (!this.#record && !this.#discardRecord && !part.startsWith('{'))) {
        this.onOutput(part);
        this.#plainLine = newline === -1;
      } else {
        if (this.#record.length + part.length > MAX_RECORD_LENGTH) {
          this.#discardRecord = true;
          this.#record = '';
        }
        if (!this.#discardRecord) {
          this.#record += part;
        }
        if (newline !== -1) {
          this.#flushRecord();
        }
      }
      start = end;
    }
  }

  finish(): void {
    this.#flushRecord();
    this.#pendingTools.clear();
  }

  #flushRecord(): void {
    const record = this.#record;
    this.#record = '';
    this.#discardRecord = false;
    if (!record) {
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(record);
    } catch {
      this.onOutput(record);
      return;
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      this.onOutput(record);
      return;
    }

    if (event.type === 'result') {
      if (typeof event.result === 'string' && event.result !== this.#lastText) {
        this.#writeText(event.result);
      }
      if (event.is_error === true && Array.isArray(event.errors)) {
        for (const error of event.errors) {
          if (typeof error === 'string') {
            this.#writeText(error);
          }
        }
      }
      return;
    }

    if (!isRecord(event.message) || !Array.isArray(event.message.content)) {
      return;
    }
    for (const block of event.message.content) {
      if (!isRecord(block)) {
        continue;
      }
      if (event.type === 'assistant') {
        this.#handleAssistantBlock(block);
      } else if (event.type === 'user') {
        this.#handleToolResult(block, event.tool_use_result);
      }
    }
  }

  #writeText(text: string): void {
    if (text) {
      this.onOutput(`${text.replace(/\r?\n/g, '\r\n')}\r\n`);
    }
  }

  #handleAssistantBlock(block: Record<string, unknown>): void {
    if (block.type === 'text' && typeof block.text === 'string') {
      this.#lastText = block.text;
      this.#writeText(block.text);
    }
    if (block.type !== 'tool_use' || typeof block.id !== 'string' || block.id.length > 128) {
      return;
    }
    const activity = getToolActivity(block);
    if (activity?.value) {
      if (this.#pendingTools.size >= MAX_PENDING_TOOLS) {
        const oldest = this.#pendingTools.keys().next().value;
        if (oldest !== undefined) {
          this.#pendingTools.delete(oldest);
        }
      }
      this.#pendingTools.set(block.id, activity);
    }
  }

  #handleToolResult(block: Record<string, unknown>, result: unknown): void {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
      return;
    }
    const activity = this.#pendingTools.get(block.tool_use_id);
    this.#pendingTools.delete(block.tool_use_id);
    if (!activity) {
      return;
    }

    const commandProducedOutput =
      activity.field === 'lastCommand' &&
      isRecord(result) &&
      typeof result.stdout === 'string' &&
      typeof result.stderr === 'string';
    if (block.is_error !== true || commandProducedOutput) {
      this.onActivity(activity.field, activity.value);
    }
  }
}
