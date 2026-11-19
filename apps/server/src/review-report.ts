import { closeSync, mkdtempSync, openSync, rmSync, unlinkSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolveReviewReportDirectory } from './artifacts.js';
import { readHistoryFile } from './history-reader.js';

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function createReviewReportDraft(repoPath: string, reportPath: string) {
  let directory: string;
  try {
    const tempRoot = resolveReviewReportDirectory(repoPath, tmpdir());
    directory = mkdtempSync(join(tempRoot, 'development-factory-review-'));
  } catch {
    const destination = resolveReviewReportDirectory(repoPath, dirname(reportPath));
    directory = mkdtempSync(join(destination, '.development-factory-review-'));
  }
  const path = join(directory, 'parecer.md');
  let published = false;

  return {
    path,
    watch(onChange: () => void) {
      watchFile(path, { interval: 500, persistent: false }, onChange);
    },
    async publish() {
      if (published) {
        return true;
      }

      let content: string;
      try {
        ({ content } = await readHistoryFile(directory, basename(path)));
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
          return false;
        }
        throw error;
      }

      if (content.trim().length === 0) {
        return false;
      }

      const destination = dirname(reportPath);
      if (resolveReviewReportDirectory(repoPath, destination) !== destination) {
        throw new Error('A pasta indicada em “Salvar code review em” mudou durante a execução.');
      }

      const file = openSync(reportPath, 'wx', 0o600);
      try {
        try {
          writeFileSync(file, content);
        } finally {
          closeSync(file);
        }
      } catch (error) {
        unlinkSync(reportPath);
        throw error;
      }

      published = true;
      return true;
    },
    dispose() {
      unwatchFile(path);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
