import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const runtime = new Set(Object.keys(manifest.dependencies ?? {}));
const builtins = new Set(builtinModules);

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(m?js)$/.test(entry.name) ? [path] : [];
  });
}

function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

test('every package the server and its scripts import is a runtime dependency, so a clean install can boot it', () => {
  const missing = [];
  for (const file of [...sources('src'), ...sources('scripts')]) {
    const code = readFileSync(file, 'utf8');
    for (const [, specifier] of code.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"./][^'"]*)['"]/g)) {
      if (specifier.startsWith('node:') || builtins.has(specifier)) continue;
      const name = packageOf(specifier);
      if (!runtime.has(name)) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});
