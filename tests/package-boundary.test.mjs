import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('host APIs are peers, never independently installed runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-home-paths', '@deepseek-ai/schemastery']) {
    assert.equal(pkg.dependencies?.[name], undefined, name + ' must not create a second host runtime');
    assert.ok(pkg.peerDependencies?.[name], name + ' must be provided by DSH');
    assert.ok(pkg.devDependencies?.[name], name + ' must remain available for independent development');
  }
});
