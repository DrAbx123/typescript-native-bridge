#!/usr/bin/env node
/**
 * Incremental composite emit: builder writeFile wrappers mutate the callback
 * `data` (data.skippedDtsWrite on the dts-unchanged skip path), so the bridge
 * emit proxy must always pass a data object — a missing one crashed every
 * edit-then-rebuild with "Cannot set properties of undefined (setting
 * 'skippedDtsWrite')". Builds a composite project, edits a file, rebuilds.
 *
 * Usage: node tools/triage-incremental-emit.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-inc-emit-'));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { composite: true, strict: true, declaration: true, outDir: 'dist', module: 'esnext', moduleResolution: 'bundler', types: [], skipLibCheck: true },
	include: ['src/**/*.ts'],
}));
fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a: number = 1;\n');

// executeCommandLine exits the process. Run the real CLI in a child so all
// three builds and the output assertion below are actually reached.
const run = () => {
	const result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'tsc'), '-b', 'tsconfig.json'],
		{ cwd: dir, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stdout + result.stderr);
};
run(); // fresh build
// Comment-only edit: version changes (affected file) but the d.ts signature
// is unchanged, driving the builder down the skip-dts-write path where it
// mutates the writeFile callback's data object.
fs.appendFileSync(path.join(dir, 'src', 'index.ts'), '// touch\n');
run();
assert.match(fs.readFileSync(path.join(dir, 'dist', 'src', 'index.js'), 'utf8'), /\/\/ touch/);
run(); // steady state

assert.ok(fs.existsSync(path.join(dir, 'dist', 'src', 'index.d.ts')), 'no d.ts emitted');
console.log('ok incremental composite rebuild (edit + dts-skip path)');
