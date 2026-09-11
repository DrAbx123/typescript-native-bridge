#!/usr/bin/env node
/**
 * `tsc --emitDeclarationOnly` must suppress JS outputs (issue #33). The
 * effective options ride updateSnapshot to Go (CLI flags never appear in the
 * on-disk tsconfig), and handleEmit narrows the default EmitOnly to
 * declarations from the wire options — before that, plain tsc emitted .js
 * files next to the sources.
 *
 * Usage: node tools/triage-emit-declaration-only.mjs
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-emit-decl-only-'));
fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
// Mirrors the issue #33 tsconfig: declaration + declarationDir, CLI-only flag.
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
	compilerOptions: { declaration: true, declarationDir: 'dist', module: 'preserve', moduleResolution: 'bundler', rootDir: 'src', strict: true, types: [], skipLibCheck: true },
	include: ['src/**/*.ts'],
}));
fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a: number = 1;\n');

process.chdir(dir);
const cli = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'tsc'), '-p', 'tsconfig.json', '--emitDeclarationOnly'], { cwd: dir, encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stdout + cli.stderr);

const js = fs.existsSync(path.join(dir, 'src', 'index.js')) || fs.existsSync(path.join(dir, 'dist', 'index.js'));
const dts = fs.existsSync(path.join(dir, 'dist', 'index.d.ts'));
if (js || !dts) {
	console.error(`FAIL: emitDeclarationOnly produced js=${js}, dts=${dts}`);
	process.exit(1);
}
console.log('ok --emitDeclarationOnly emits d.ts only');

// Bundlers can set relative directories directly on CompilerOptions and
// depend on writeFile receiving that same path form, including a leading ./.
const stockPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH && path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js'))
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
const stock = require(stockPath);
const roots = ['index.ts', 'module.mts', 'common.cts', 'component.tsx'].map(name => path.join(dir, 'src', name).replaceAll('\\', '/'));
for (const file of roots) fs.writeFileSync(file, 'export interface Item { value: string; }\nexport const item: Item = { value: "ok" };\n');
const variants = [
	{ outDir: '.', declarationDir: '.' },
	{ outDir: 'js', declarationDir: 'types' },
	{ outDir: './js', declarationDir: './types' },
	{ outDir: '../js', declarationDir: '../types' },
	{ outDir: '.', declarationDir: path.join(dir, 'types') },
	{ outDir: path.join(dir, 'js'), declarationDir: './types' },
	{ outDir: '.' },
	{ declarationDir: '.' },
	{ outDir: '.', incremental: true, tsBuildInfoFile: './cache/build.tsbuildinfo' },
];
function collectEmitPaths(tsModule, extra, single, differentCwd = false) {
	const options = {
		strict: true, declaration: true, declarationMap: true, sourceMap: true,
		listEmittedFiles: true, types: [], target: tsModule.ScriptTarget.ES2022,
		module: tsModule.ModuleKind.Preserve, moduleResolution: tsModule.ModuleResolutionKind.Bundler,
		jsx: tsModule.JsxEmit.Preserve, rootDir: path.join(dir, 'src'),
		configFilePath: path.join(dir, 'tsconfig.json'), ...extra,
	};
	const host = tsModule.createCompilerHost(options);
	if (differentCwd) host.getCurrentDirectory = () => path.dirname(dir);
	const program = tsModule.createProgram({ rootNames: roots, options, host });
	const written = [];
	const result = program.emit(single ? program.getSourceFile(roots[0]) : undefined,
		fileName => written.push(fileName), undefined, single);
	assert.equal(result.emitSkipped, false);
	return { written: written.sort(), emitted: result.emittedFiles?.sort() };
}
for (const extra of variants) {
	for (const single of [false, true]) {
		for (const differentCwd of [false, true]) {
			assert.deepEqual(collectEmitPaths(ts, extra, single, differentCwd), collectEmitPaths(stock, extra, single, differentCwd),
				`writeFile/emittedFiles paths must match stock for ${JSON.stringify(extra)} single=${single} differentCwd=${differentCwd}`);
		}
	}
}
console.log('ok relative output callback paths match stock');
// Native emits individual files for outFile, so pretending to support this
// request would silently replace a bundle with unrelated per-file outputs.
for (const single of [false, true]) {
	assert.throws(() => collectEmitPaths(ts, { outFile: './bundle.js', module: ts.ModuleKind.AMD }, single), /does not support outFile bundles/);
}
console.log('ok unsupported native outFile bundles reject explicitly');
