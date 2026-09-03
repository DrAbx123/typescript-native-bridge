#!/usr/bin/env node
/**
 * Issues #69/#70 witness: Type.ThisType() (added for #53) gated on
 * objectFlags' ClassOrInterface|Tuple mask, but a reference re-created from
 * a tuple type's objectFlags carries the Tuple flag while its data stays
 * *TypeReference — AsInterfaceType() is nil there and the accessor
 * nil-dereferenced, killing the process the moment any consumer (e.g.
 * @typescript-eslint/no-unsafe-assignment) asked the checker for such a
 * type. The accessor now gates on the data shape instead of the flags.
 *
 * Pre-fix this probe dies with a Go panic on the first walk. Post-fix it
 * walks every node of both issue repros in lockstep against stock and pins
 * thisType parity per node — including the non-obvious stock shapes: the
 * tuple type at a tuple-type ANNOTATION carries thisType (in both engines),
 * while the tuple-typed array LITERAL's reference stays field-less.
 *
 * Stock side: STOCK_TYPESCRIPT_PATH, else derived from STOCK_TSSERVER_PATH
 * (CI), else /tmp/stock-ts-p3/package/lib/typescript.js.
 *
 * Usage: node tools/triage-thistype-refguard.mjs
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require2 = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const tsb = require2(path.join(repoRoot, 'lib', 'typescript.js')); // TNB
const stockTsPath = process.env.STOCK_TYPESCRIPT_PATH
    ?? (process.env.STOCK_TSSERVER_PATH ? path.join(path.dirname(process.env.STOCK_TSSERVER_PATH), 'typescript.js') : undefined)
    ?? '/tmp/stock-ts-p3/package/lib/typescript.js';
const tss = require2(stockTsPath); // stock

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-thistype-'));
const fixture = {
    // #70: empty tuple contextual type
    'a.ts': `export const empty: [] = [];\n`,
    // #69: destructuring a cloned tuple reference
    'b.ts': `export const f = (input: [string[] | undefined]) => {\n\tconst [[a] = []] = input\n\treturn a\n}\n`,
};
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' },
    include: Object.keys(fixture),
}));
for (const [name, text] of Object.entries(fixture)) fs.writeFileSync(path.join(dir, name), text);

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

function tnbProgram() {
    const NOOP = () => {};
    const host = tsb.createWatchCompilerHost(path.join(dir, 'tsconfig.json'), {}, tsb.sys, tsb.createAbstractBuilder, NOOP, NOOP);
    host.watchFile = () => ({ close: NOOP });
    host.watchDirectory = () => ({ close: NOOP });
    host.setTimeout = undefined;
    host.clearTimeout = undefined;
    let builder;
    host.afterProgramCreate = b => { builder = b; };
    const watch = tsb.createWatchProgram(host);
    return { program: (builder ?? watch.getProgram()).getProgram(), close: () => watch.close?.() };
}
function stockProgram() {
    const program = tss.createProgram([path.join(dir, 'a.ts'), path.join(dir, 'b.ts')], {
        strict: true, noEmit: true, target: tss.ScriptTarget.ES2022, module: tss.ModuleKind.ESNext, moduleResolution: tss.ModuleResolutionKind.Bundler,
    });
    return { program, close: () => {} };
}

const tnb = tnbProgram();
const stk = stockProgram();
const tnbChecker = tnb.program.getTypeChecker();
const stkChecker = stk.program.getTypeChecker();

function flatten(sf) {
    const out = [];
    (function walk(node) {
        out.push(node);
        node.forEachChild(walk);
    })(sf);
    return out;
}

let compared = 0;
let sawThisTypePresent = false;
for (const name of Object.keys(fixture)) {
    // Lockstep walk: same source text, so both parsers yield the same
    // (kind, pos) sequence. Pre-fix the TNB call panics mid-walk.
    const tnbNodes = flatten(tnb.program.getSourceFile(path.join(dir, name)));
    const stkNodes = flatten(stk.program.getSourceFile(path.join(dir, name)));
    check(tnbNodes.length === stkNodes.length, `${name}: node-count drift tnb=${tnbNodes.length} stock=${stkNodes.length}`);
    const n = Math.min(tnbNodes.length, stkNodes.length);
    for (let i = 0; i < n; i++) {
        const a = tnbNodes[i], b = stkNodes[i];
        const label = `${name}:${a.pos} ${tsb.SyntaxKind[a.kind]}`;
        check(a.kind === b.kind && a.pos === b.pos, `${label}: lockstep drift vs stock (${tss.SyntaxKind[b.kind]}@${b.pos})`);
        // Stock throws a TypeError on getTypeAtLocation(SourceFile) (parentless
        // node quirk) — outside the bridge's contract surface; skip it.
        if (a.kind === tsb.SyntaxKind.SourceFile) continue;
        const ta = tnbChecker.getTypeAtLocation(a);
        const tb = stkChecker.getTypeAtLocation(b);
        check((ta == null) === (tb == null), `${label}: nullness drift tnb=${ta != null} stock=${tb != null}`);
        if (ta && tb) {
            compared++;
            const taHas = ta.thisType !== undefined;
            const tbHas = tb.thisType !== undefined;
            check(taHas === tbHas, `${label}: thisType presence drift tnb=${taHas} stock=${tbHas}`);
            if (taHas) sawThisTypePresent = true;
        }
    }
}

check(sawThisTypePresent, 'no node surfaced a thisType on either side — the #53 wire field went untested');

// #69 pin: the destructured binding element `a` is string on both sides.
const sfb = tnb.program.getSourceFile(path.join(dir, 'b.ts'));
let aType;
(function walk(node) {
    if (tsb.isIdentifier(node) && node.getText(sfb) === 'a' && tsb.isBindingElement(node.parent) && node.parent.name === node) {
        aType ??= tnbChecker.getTypeAtLocation(node);
    }
    node.forEachChild(walk);
})(sfb);
check(aType && (aType.flags & tsb.TypeFlags.String) !== 0, `b.ts binding element a: expected string, got flags=${aType?.flags}`);

tnb.close();
stk.close();
if (failures.length) {
    console.error('FAIL');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
}
console.log(`ok thistype-refguard: #69/#70 repros, thisType parity on ${compared} typed nodes vs stock (fork ${tsb.version})`);
