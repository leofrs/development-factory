import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FACTORY_ACTIVITY_LENGTH } from '@development-factory/shared';
import { FactoryCliOutput, formatFactoryActivityValue } from '../src/factory-cli-output.js';
import type { FactoryActivityField } from '../src/factory-cli-output.js';

test('FactoryCliOutput reconstrói registros do PTY e publica atividade confirmada', () => {
  const activity: { field: FactoryActivityField; value: string }[] = [];
  const output: string[] = [];
  const stream = new FactoryCliOutput(
    chunk => output.push(chunk),
    (field, value) => activity.push({ field, value }),
  );
  const assistant = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Conferindo o repositório.' },
        { type: 'tool_use', id: '1', name: 'Read', input: { file_path: 'src/negado.ts' } },
        {
          type: 'tool_use',
          id: '2',
          name: 'Bash',
          input: { command: 'npm test --token abcdef123456789' },
        },
      ],
    },
  });
  const skipped = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: '1', is_error: true }] },
  });
  const ran = JSON.stringify({
    type: 'user',
    tool_use_result: { stdout: '', stderr: 'Falha no teste' },
    message: { content: [{ type: 'tool_result', tool_use_id: '2', is_error: true }] },
  });
  const result = JSON.stringify({ type: 'result', result: 'Conferindo o repositório.' });

  stream.append('Saída simples\r\n');
  stream.append(assistant.slice(0, 30));
  assert.deepEqual(activity, []);
  stream.append(`${assistant.slice(30)}\r\n${skipped}\r\n${ran}\r\n${result}`);
  stream.finish();

  assert.deepEqual(activity, [{ field: 'lastCommand', value: 'npm test --token [REDACTED]' }]);
  assert.equal(output.join(''), 'Saída simples\r\nConferindo o repositório.\r\n');
});

test('formatFactoryActivityValue redige antes de truncar e remove controles do terminal', () => {
  const secret = 'abcde123456789';
  const prefix = 'x'.repeat(MAX_FACTORY_ACTIVITY_LENGTH - 20);
  const value = formatFactoryActivityValue(`\u001b[32m${prefix}\u001b[0m --token ${secret}\nextra`);

  assert.equal(value.length, MAX_FACTORY_ACTIVITY_LENGTH);
  assert.equal(value, `${prefix} --token [REDACTED]…`);
});
