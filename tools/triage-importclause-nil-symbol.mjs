#!/usr/bin/env node
/**
 * Issue #71 witness: a type-only ImportClause is an IsTypeDeclaration node
 * the binder never gives a symbol, so getTypeOfNode's IsTypeDeclaration
 * branch called getDeclaredTypeOfSymbol(nil) and nil-dereferenced — a
 * process-fatal Go panic where stock's same call is a catchable TypeError.
 * tryGetDeclaredTypeOfSymbol now returns nil for a nil symbol (Ledger
 * tsgo-declaredtype-nil-symbol), surfacing the error type instead.
 *
 * Pre-fix this probe dies with a Go panic on the clause; post-fix it walks
 * the whole file and pins: the clause yields the error type, and the
 * specifier's own resolution (`Thing` → the interface) is unaffected.
 *
 * Usage: node tools/triage-importclause-nil-symbol.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js')); // TNB

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-importclause-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
    include: ['a.ts', 'other.ts'],
}));
fs.writeFileSync(path.join(dir, 'a.ts'), `import type {Thing} from './other';\n\nexport const describe = (thing: Thing) => thing.name;\n`);
fs.writeFileSync(path.join(dir, 'other.ts'), `export interface Thing { name: string }\n`);

const NOOP = () => {};
const host = tsb.createWatchCompilerHost(path.join(dir, 'tsconfig.json'), {}, tsb.sys, tsb.createAbstractBuilder, NOOP, NOOP);
host.watchFile = () => ({ close: NOOP });
host.watchDirectory = () => ({ close: NOOP });
host.setTimeout = undefined;
host.clearTimeout = undefined;
let builder;
host.afterProgramCreate = b => { builder = b; };
const watch = tsb.createWatchProgram(host);
const program = (builder ?? watch.getProgram()).getProgram();
const checker = program.getTypeChecker();
const sf = program.getSourceFile(path.join(dir, 'a.ts'));

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

let clauseType;
let thingType;
let walked = 0;
(function walk(node) {
    const t = checker.getTypeAtLocation(node); // pre-fix: Go panic at the ImportClause
    walked++;
    if (tsb.isImportClause(node)) clauseType ??= t;
    if (tsb.isIdentifier(node) && node.getText(sf) === 'Thing' && tsb.isImportSpecifier(node.parent)) thingType ??= t;
    node.forEachChild(walk);
})(sf);

check(clauseType != null, 'type-only ImportClause: getTypeAtLocation returned nothing');
check(clauseType != null && (clauseType.flags & tsb.TypeFlags.Any) !== 0 && clauseType.intrinsicName === 'error',
    `type-only ImportClause: expected the error type, got flags=${clauseType?.flags} intrinsicName=${clauseType?.intrinsicName}`);
check(thingType != null && (thingType.flags & tsb.TypeFlags.Object) !== 0 && thingType.symbol?.name === 'Thing',
    `Thing specifier: expected the interface type, got flags=${thingType?.flags} symbol=${thingType?.symbol?.name}`);

watch.close?.();
if (failures.length) {
    console.error('FAIL');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log(`ok importclause-nil-symbol: #71 repro walked (${walked} nodes), clause → error type, specifier resolution intact (fork ${tsb.version})`);
