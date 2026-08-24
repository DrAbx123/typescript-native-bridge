#!/usr/bin/env node
/**
 * Pin the jsDoc cache write on the tsgo-backed RemoteNode.
 *
 * Stock TypeScript's NodeObject.jsDoc is a writable cache slot; the bridge's
 * NodeHandle (RemoteNode) exposes `jsDoc` as a getter-only property. Third-party
 * plugins (e.g. ts-lit-plugin) call ts.getJSDocTags(node) and then write the
 * cache back via `node.jsDoc ??= []` — on the RemoteNode that SET throws
 * "Cannot set property jsDoc ... which has only a getter", which aborts the
 * plugin's analysis caching and makes it re-run a ~400ms lib.dom.d.ts walk on
 * every diagnostics call.
 *
 * This witness asserts getJSDocTags works on a lib.dom.d.ts declaration node
 * (i.e. the cache write does not throw).
 *
 * Exit 0: getJSDocTags returns without throwing. Exit 1: the jsDoc set throws
 * (the bridge-contract divergence).
 *
 * Usage: node tools/triage-jsdoc-writable.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = require(path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js')));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-jsdoc-writable-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'esnext', lib: ['lib.dom.d.ts'] }, include: ['*.ts'] }));
const mainPath = path.join(dir, 'main.ts');
fs.writeFileSync(mainPath, 'export const x: string = document.title;\n');

const host = {
    getScriptFileNames: () => [mainPath],
    getScriptVersion: () => '1',
    getScriptSnapshot: f => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined),
    getCurrentDirectory: () => dir,
    getCompilationSettings: () => ({ target: ts.ScriptTarget.ESNext, lib: ['lib.dom.d.ts'], configFilePath: path.join(dir, 'tsconfig.json') }),
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
    const defaultLib = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ESNext, lib: ['lib.dom.d.ts'] });
    const libDom = program.getSourceFile(path.join(path.dirname(defaultLib), 'lib.dom.d.ts'));
    if (!libDom) throw new Error('lib.dom.d.ts not found');

    // Find the first interface declaration node, then resolve its symbol's
    // declaration through the checker — that returns a NodeHandle (the wrapper
    // whose jsDoc is getter-only), which is the object ts-lit-plugin passes to
    // getJSDocTags.
    const checker = program.getTypeChecker();
    let target;
    function findDecl(node) {
        if (target) return;
        if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
            target = node;
            return;
        }
        node.forEachChild(findDecl);
    }
    libDom.forEachChild(findDecl);
    if (!target) throw new Error('no declaration node found in lib.dom.d.ts');

    const sym = checker.getSymbolAtLocation(target.name);
    const decl = sym?.declarations?.[0] ?? target;

    try {
        const tags = ts.getJSDocTags(decl);
        console.log(`check:jsdoc-writable ok (getJSDocTags returned ${tags.length} tags)`);
    }
    catch (e) {
        throw new Error(`getJSDocTags threw on a lib.dom.d.ts NodeHandle: ${e?.message ?? e}`);
    }
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
