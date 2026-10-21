import test from 'node:test'; import assert from 'node:assert/strict';
import { createHash } from 'node:crypto'; import { readdirSync, readFileSync } from 'node:fs';
// core/ is a copy of copilot-check/core; edits belong there (then `pnpm sync-core`).
test('core matches its VERSION hash', () => {
  const h = createHash('sha256');
  for (const f of readdirSync('core').filter(f => f.endsWith('.js')).sort()) h.update(f + '\0' + readFileSync(`core/${f}`, 'utf8') + '\0');
  assert.equal(h.digest('hex'), readFileSync('core/VERSION', 'utf8').trim());
});
