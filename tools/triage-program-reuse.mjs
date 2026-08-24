#!/usr/bin/env node
/**
 * Pin createLanguageService program reuse across unchanged getProgram() calls.
 *
 * Stock's LanguageService.getProgram() runs isProgramUptoDate before deciding
 * whether to re-create the program. The thin tsgo program's SourceFile.version
 * used to report the Go content hash, which never matches
 * host.getScriptVersion, so isProgramUptoDate always returned false and every
 * getProgram() rebuilt the whole thin program.
 *
 * This witness pins the createLanguageService path (a LanguageServiceHost with
 * NO projectService): SourceFile.version reports a frozen snapshot of
 * host.getScriptVersion captured at createTsgoProgram time, so an unchanged
 * host yields the same program object across getProgram() calls.
 *
 * Exit 0: two getProgram() calls with no host change return the same program
 * object. Exit 1: the program was rebuilt (the divergence).
 *
 * Usage: node tools/triage-program-reuse.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = require(path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js')));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-program-reuse-'));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'esnext' }, include: ['*.ts'] }));

const mainPath = path.join(dir, 'main.ts');
let scriptVersion = '1';
let mainText = 'export const x: number = 1;\n';

const host = {
    getScriptFileNames: () => [mainPath],
    getScriptVersion: () => scriptVersion,
    getScriptSnapshot: f => (f === mainPath ? ts.ScriptSnapshot.fromString(mainText) : undefined),
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
    const program1 = ls.getProgram();
    const program2 = ls.getProgram();
    if (program1 !== program2) {
        throw new Error('program was rebuilt across unchanged getProgram() calls — program reuse did not hold');
    }

    // A content-only edit (host version + snapshot change) must rebuild.
    scriptVersion = '2';
    mainText = 'export const x: number = 2;\n';
    const program3 = ls.getProgram();
    if (program1 === program3) {
        throw new Error('program was reused after a content change — change detection did not hold');
    }

    console.log('check:program-reuse ok (reuse on unchanged host; rebuild on content change)');
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
