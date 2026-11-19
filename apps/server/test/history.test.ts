import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFactoryHistory } from '../src/history.js';

test('preserva saída sem ANSI entre chunks e identifica planejamento interrompido', context => {
  const directory = mkdtempSync(join(tmpdir(), 'review-history-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const states: string[] = [];
  const history = createFactoryHistory({ inputType: 'title', value: '123', repoPath: directory }, state => states.push(state), message => assert.fail(message));
  history.record('\x1b[');
  history.record('31mProblema crítico\x1b[0m\r\n');
  history.record('\x1b]0;título');
  history.record('\x07Mais informações\n');
  history.finish('interrompido');
  history.finish('não deve finalizar duas vezes');
  const session = readFileSync(history.sessionPath, 'utf8');
  assert(session.includes('Problema crítico\n    Mais informações'));
  assert(!session.includes('\x1b'));
  assert.match(readFileSync(history.reportPath, 'utf8'), /Plano da tarefa incompleto/);
  assert.deepEqual(states, ['incomplete']);
});

test('preserva o Markdown final e cria arquivos distintos por sessão', context => {
  const directory = mkdtempSync(join(tmpdir(), 'review-history-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const request = { inputType: 'title', value: '../../feature', repoPath: directory } as const;
  const states: string[] = [];
  const first = createFactoryHistory(request, state => states.push(state), message => assert.fail(message));
  const second = createFactoryHistory(request, () => {}, message => assert.fail(message));
  assert.notEqual(first.reportPath, second.reportPath);
  assert.equal(join(first.reportPath, '..'), join(directory, '.code-reviews'));
  const result = '# Review\n\n## Veredito\nAJUSTES NECESSÁRIOS\n';
  writeFileSync(first.reportPath, result);
  first.finish('concluído');
  second.finish('interrompido');
  assert.equal(readFileSync(first.reportPath, 'utf8'), result);
  assert.deepEqual(states, ['saved']);
});

test('recusa diretório de histórico que redireciona para fora do repositório', context => {
  const directory = mkdtempSync(join(tmpdir(), 'review-history-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'repo'));
  mkdirSync(join(directory, 'outro'));
  symlinkSync(join(directory, 'outro'), join(directory, 'repo', '.code-reviews'));
  assert.throws(() => createFactoryHistory({ inputType: 'title', value: '1', repoPath: join(directory, 'repo') }, () => {}, () => {}), /diretório real/);
});
