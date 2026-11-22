#!/usr/bin/env node
// CLI de teste: o teste copia este arquivo como executável "claude" em um PATH temporário.
// Mantido no subconjunto JavaScript do TypeScript para funcionar também no Node 22.
import { writeFileSync } from 'node:fs';
process.stdin.setRawMode(true);
process.stdin.resume();
console.log(`READY:${JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), term: process.env.TERM, color: process.env.COLORTERM, tty: process.stdin.isTTY })}`);
process.stdout.on('resize', () => console.log(`SIZE:${process.stdout.columns}x${process.stdout.rows}`));
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  if (text.includes('\u0003')) process.exit(130);
  if (text === 'EXIT0') process.exit(0);
  if (text === 'EXIT') process.exit(7);
  if (text === 'ACTIVITY' && process.argv.includes('stream-json')) {
    const tools = [
      { id: 'read', name: 'Read', input: { file_path: 'src/index.ts' } },
      { id: 'write', name: 'Write', input: { file_path: 'triage.md', content: 'relatório bruto' } },
    ];
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: { content: tools.map(tool => ({ type: 'tool_use', ...tool })) },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'user',
        message: {
          content: tools.map(({ id }) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })),
        },
      }),
    );
  }
  if (text === 'SAVE') {
    const promptArg = process.argv.slice(2).find(arg => arg.includes('no arquivo '));
    const match = promptArg?.match(/no arquivo ("(?:\\.|[^"\\])*")\./);
    if (match?.[1]) writeFileSync(JSON.parse(match[1]), '# Parecer final\n\nAPROVADO\n');
  }
  console.log(`INPUT:${text}`);
});
