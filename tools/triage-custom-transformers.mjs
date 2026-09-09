#!/usr/bin/env node
/**
 * Witness for issue #40: never silently discard custom transformers.
 * JavaScript transforms remain unsupported. Declaration syntax transforms
 * must rewrite native-inferred types exactly like stock; maps/bundles still
 * reject them explicitly. Empty transformer arrays preserve normal emit.
 *
 * Exit: 0 = PASS, 1 = FAIL.
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const ts = require(path.join(repoRoot, 'lib', 'typescript.js'));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-custom-transformers-'));
const configFile = path.join(fixture, 'tsconfig.json');
const mainFile = path.join(fixture, 'main.ts');
fs.writeFileSync(mainFile, 'export const x: number = 1;\n');
fs.writeFileSync(configFile, JSON.stringify({
	compilerOptions: { strict: true, module: 'commonjs', target: 'es2022', outDir: 'out' },
	files: ['main.ts'],
}));

const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, ts.sys);
if (!parsed) {
	console.error('FAIL: could not parse fixture tsconfig');
	process.exit(1);
}
const program = ts.createProgram(parsed.fileNames, parsed.options);

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? 'ok' : 'FAIL'} ${label}`);
	if (!ok) failed++;
};

const expectThrow = (label, customTransformers, targetProgram = program) => {
	try {
		targetProgram.emit(undefined, undefined, undefined, false, customTransformers);
		check(`${label}: threw`, false);
	} catch (e) {
		check(`${label}: throws customTransformers error`, /customTransformers/.test(String(e?.message ?? e)));
	}
};
const identity = () => sf => sf;
expectThrow('before:[fn]', { before: [identity] });
expectThrow('after:[fn]', { after: [identity] });

// Empty shells: no transformation happens either way — normal emit proceeds.
const written = [];
const res = program.emit(undefined, (fileName, text) => written.push(fileName), undefined, false, { before: [], after: [], afterDeclarations: [] });
check('empty shells: emit proceeds', !res.emitSkipped && written.some(f => f.endsWith('.js')));

fs.writeFileSync(mainFile, 'export const surface = { internal: 1, public: "x" };\n');
const declarationOptions = { ...parsed.options, declaration: true, emitDeclarationOnly: true };
function declarationOutput(sdk) {
	const output = [];
	const declarationProgram = sdk.createProgram(parsed.fileNames, declarationOptions);
	const transform = context => sourceFile => {
		const visit = node => {
			if (sdk.isPropertySignature(node) && sdk.isIdentifier(node.name) && node.name.text === 'internal') {
				return context.factory.updatePropertySignature(node, node.modifiers,
					context.factory.createStringLiteral('#internal'), node.questionToken, node.type);
			}
			return sdk.visitEachChild(node, visit, context);
		};
		return sdk.visitEachChild(sourceFile, visit, context);
	};
	const result = declarationProgram.emit(undefined, (file, text) => {
		if (file.endsWith('.d.ts')) output.push(text.replaceAll('\r\n', '\n'));
	}, undefined, true, { afterDeclarations: [transform] });
	check(`${sdk === ts ? 'native' : 'stock'}: declaration syntax transform emitted`, !result.emitSkipped && result.diagnostics.length === 0 && output.length === 1);
	return output;
}
const stockPath = process.env.STOCK_TYPESCRIPT_PATH
	?? (process.env.STOCK_TSSERVER_PATH && path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js'))
	?? '/tmp/stock-ts-p3/package/lib/typescript.js';
const nativeOutput = declarationOutput(ts);
const stockOutput = declarationOutput(require(stockPath));
check('afterDeclarations: inferred types and rewritten syntax match stock', JSON.stringify(nativeOutput) === JSON.stringify(stockOutput));
check('afterDeclarations: transformer ran', nativeOutput[0]?.includes('"#internal": number'));
for (const [label, extra] of [['declarationMap', { declarationMap: true }], ['outFile', { outFile: path.join(fixture, 'bundle.d.ts') }]]) {
	const unsupported = ts.createProgram(parsed.fileNames, { ...declarationOptions, ...extra });
	expectThrow(`${label}: afterDeclarations`, { afterDeclarations: [identity] }, unsupported);
}

fs.rmSync(fixture, { recursive: true, force: true });

process.exit(failed ? 1 : 0);
