#!/usr/bin/env node
/**
 * Pin the spelling-suggestion materialization memo across checker lifetimes.
 *
 * A property-typo on a large intersection type is turned into a "did you mean"
 * (2551) suggestion. Stock materializes the type's member list once and reuses
 * it across getSemanticDiagnostics / getSuggestedSymbolForNonexistentProperty /
 * getSuggestionDiagnostics; the bridge's Go checker lifetime is per-call, so the
 * same resolvedProperties is recomputed once per path — the fork's ~2.5x
 * per-computation win is eaten by ~3x redundancy, and getCodeFixes ends up slow
 * enough to be cancelled (OperationCanceledException → stock wraps it as
 * `[object Object]`).
 *
 * This witness asserts the cross-path memo: after getSemanticDiagnostics has
 * materialized the type, a direct getSuggestedSymbolForNonexistentProperty on
 * the SAME type must be memoized (near the same-checker cost), not re-derive the
 * whole member list.
 *
 * Exit 0: the cross-path memo holds. Exit 1: the type is being re-materialized
 * (the divergence).
 *
 * Usage: node tools/triage-spell-memo.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = require(path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js')));

// Fixture size: large enough that the cold materialization is clearly above
// noise, small enough that the witness stays fast. M interfaces x P members,
// joined as an intersection type (the shape that makes tsgo materialize the
// union/intersection member list eagerly).
const M = 100;
const P = 200;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-spell-memo-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'esnext' }, include: ['*.ts'] }));

let decls = '';
for (let m = 0; m < M; m++) {
    let body = '';
    for (let p = 0; p < P; p++) body += `  f${m}_${p}: number;\n`;
    decls += `interface I${m} {\n${body}}\n`;
}
const type = Array.from({ length: M }, (_, m) => `I${m}`).join(' & ');
fs.writeFileSync(path.join(dir, 'big.d.ts'), `${decls}\nexport declare const obj: ${type};\n`);

const mainContent = `import { obj } from './big';\nobj.f0_0x;\n`;
const mainPath = path.join(dir, 'main.ts');
fs.writeFileSync(mainPath, mainContent);
const typo = mainContent.indexOf('f0_0x');

const host = {
    getScriptFileNames: () => [mainPath],
    getScriptVersion: () => '1',
    getScriptSnapshot: f => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined,
    getCurrentDirectory: () => dir,
    getCompilationSettings: () => ({ strict: true, noEmit: true, target: ts.ScriptTarget.ESNext, configFilePath: path.join(dir, 'tsconfig.json') }),
    getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => '\n',
};

try {
    const ls = ts.createLanguageService(host);
    const program = ls.getProgram();
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(mainPath);
    const node = ts.getTokenAtPosition(sf, typo);
    const containingType = checker.getTypeAtLocation(node.parent.expression);

    const time = (fn) => {
        const t0 = Date.now();
        const r = fn();
        return { ms: Date.now() - t0, r };
    };

    // Warm the spelling path once: this materializes the intersection member
    // list on the API checker (and pays the one-time host-side parse of
    // big.d.ts) so the cross-path assertion below is not polluted by either.
    checker.getSuggestedSymbolForNonexistentProperty(node, containingType);

    // A. semantic diagnostics uses the diagnostics checker. With the program-level
    //    resolvedProperties cache it must be a memo hit; without it, it re-derives
    //    the whole member list on its own checker (~100ms at this fixture size).
    const A = time(() => program.getSemanticDiagnostics(sf));
    // B. spelling again on the already-warmed API checker — the same-checker memo
    //    baseline (a few ms).
    const B = time(() => checker.getSuggestedSymbolForNonexistentProperty(node, containingType));

    console.log(`check:spell-memo A(semantic-after-warm)=${A.ms}ms B(suggest-warm)=${B.ms}ms`);

    // A must be a memo hit: the diagnostics checker reuses the materialization
    // already produced by the spelling path. A re-derivation is ~an order of
    // magnitude slower than the same-checker memo, so 50ms cleanly separates them.
    if (A.ms > 50) {
        throw new Error(
            `semantic diagnostics re-materialized after spelling warm-up: A=${A.ms}ms B=${B.ms}ms — ` +
            'the resolvedProperties memo is not shared across checker lifetimes',
        );
    }
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
