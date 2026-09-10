#!/usr/bin/env node
/**
 * Pin disk freshness across fresh Programs and unchanged LanguageService reuse.
 *
 * Stock's LanguageService.getProgram() runs isProgramUptoDate before deciding
 * whether to re-create the program. The thin tsgo program's SourceFile.version
 * used to report the Go content hash, which never matches
 * host.getScriptVersion, so isProgramUptoDate always returned false and every
 * getProgram() rebuilt the whole thin program.
 *
 * The createLanguageService path uses a LanguageServiceHost without
 * projectService. Unchanged host snapshots must reuse the Program, while a
 * versioned content edit must rebuild. Fresh plain Programs must observe disk
 * changes to roots, imports and declarations both before and after LS use.
 *
 * Exit 0: all freshness and reuse assertions pass. Exit 1: a regression.
 *
 * Usage: node tools/triage-program-reuse.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = require(path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js')));

const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-program-reuse-')));
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'esnext' }, include: ['*.ts'] }));

const mainPath = path.join(dir, 'main.ts').replaceAll('\\', '/');
let scriptVersion = '1';
let mainText = 'export const x: number = 1;\n';
fs.writeFileSync(mainPath, mainText);

const host = {
    getScriptFileNames: () => [mainPath],
    getScriptVersion: () => scriptVersion,
    getScriptSnapshot: f => {
        const text = f.replaceAll('\\', '/') === mainPath ? mainText : ts.sys.readFile(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dir,
    getCompilationSettings: () => ({ strict: true, noEmit: true, target: ts.ScriptTarget.ESNext, configFilePath: path.join(dir, 'tsconfig.json').replaceAll('\\', '/') }),
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
    checkDiskPrograms('before-ls');
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

    // A preceding LS must not supply the host for an unrelated CompilerHost.
    checkDiskPrograms('after-ls');
    assert.equal(ls.getProgram(), program3, 'plain Programs must not invalidate an unchanged LS Program');
    ls.dispose();
    checkTextCompilerHost(!!program1.isTsgoBackedProgram);
    console.log('check:program-reuse ok (fresh disk Programs; unchanged LS reuse; rebuild on content change)');
}
finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

function checkTextCompilerHost(native) {
    const textDir = path.join(dir, 'text-host').replaceAll('\\', '/');
    fs.mkdirSync(textDir);
    const virtual = `${textDir}/virtual.ts`;
    const canonical = file => ts.sys.useCaseSensitiveFileNames ? file.replaceAll('\\', '/') : file.replaceAll('\\', '/').toLowerCase();
    const dependency = `${textDir}/dependency.ts`;
    const options = {
        strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        configFilePath: `${textDir}/tsconfig.json`,
    };
    fs.writeFileSync(options.configFilePath, JSON.stringify({ compilerOptions: {
        strict: true, noEmit: true, types: [], target: 'esnext', module: 'esnext', moduleResolution: 'bundler',
    }, files: ['virtual.ts'] }));
    let virtualText = 'import { value } from "./dependency";\nexport const firstVirtual: number = value;\n';
    fs.writeFileSync(dependency, 'export const value = "bad";\n');
    const compilerHost = ts.createCompilerHost(options);
    const getSourceFile = compilerHost.getSourceFile;
    let virtualAstReads = 0;
    compilerHost.tnbGetSourceText = file => {
        const text = file.replaceAll('\\', '/') === virtual ? virtualText : ts.sys.readFile(file);
        return text === undefined ? undefined : { text, scriptKind: ts.ScriptKind.TS };
    };
    compilerHost.getSourceFile = (file, ...args) => {
        if (file.replaceAll('\\', '/') !== virtual) return getSourceFile(file, ...args);
        virtualAstReads++;
        return virtualText === undefined ? undefined : ts.createSourceFile(file, virtualText, options.target, true, ts.ScriptKind.TS);
    };
    const makeProgram = () => ts.createProgram({ rootNames: [virtual], options, host: compilerHost });
    const first = makeProgram();
    assert.deepEqual(first.getSemanticDiagnostics().map(d => d.code), [2322]);
    ts.performance.enable();
    const parsesBeforeWalk = ts.performance.getCount('beforeParse');
    const entry = first.getSourceFiles().find(sf => canonical(sf.fileName) === canonical(virtual));
    assert.ok(entry, 'metadata enumeration must contain the virtual root');
    assert.equal(canonical(first.getSourceFileByPath(entry.path).fileName), canonical(virtual));
    assert.equal(entry.text, virtualText, 'enumeration must expose transformed text');
    if (native) {
        assert.equal(virtualAstReads, 0, 'text-only host must not construct an unused virtual AST');
        assert.equal(ts.performance.getCount('beforeParse'), parsesBeforeWalk,
            'metadata enumeration must not parse the virtual-file corpus again');
    }
    // AST consumers must still see real statements and navigation text.
    assert.equal(entry.statements.length, 2);
    assert.equal(entry.statements[1].declarationList.declarations[0].name.getText(), 'firstVirtual');
    assert.equal(first.getSourceFile(virtual), first.getSourceFileByPath(entry.path));
    const checkResolution = (program, expectedFile) => {
        const source = program.getSourceFile(virtual);
        const specifier = source.statements[0].moduleSpecifier;
        const mode = program.getModeForUsageLocation(source, specifier);
        const cached = program.getResolvedModule(source, specifier.text, mode);
        assert.ok(cached?.resolvedModule, 'text-only host import must have a program resolution');
        assert.equal(canonical(cached.resolvedModule.resolvedFileName), canonical(expectedFile));
        assert.equal(program.getResolvedModuleFromModuleSpecifier(specifier, source), cached);
        assert.equal(program.getResolvedModuleFromModuleSpecifier(specifier), cached);
        assert.equal(program.getResolvedModuleFromModuleSpecifier(specifier, program.getSourceFileByPath(source.path)), cached);
    };
    checkResolution(first, dependency);
    ts.performance.disable();

    // A text hook does not promise LS versioning: imported disk edits must
    // refresh even when the virtual root text is unchanged.
    fs.writeFileSync(dependency, 'export const value = 1;\n');
    const unchangedRoot = makeProgram();
    assert.deepEqual(unchangedRoot.getSemanticDiagnostics(), []);
    assert.equal(unchangedRoot.getSourceFile(virtual).statements[1].declarationList.declarations[0].name.getText(), 'firstVirtual',
        'a deduplicated overlay must still provide the new Program with a real AST');
    virtualText = virtualText.replace('firstVirtual', 'secondVirtual');
    const second = makeProgram();
    const nextEntry = second.getSourceFiles().find(sf => canonical(sf.fileName) === canonical(virtual));
    assert.match(nextEntry.text, /secondVirtual/);
    assert.equal(nextEntry.statements[1].declarationList.declarations[0].name.getText(), 'secondVirtual');
    assert.equal(entry.statements[1].declarationList.declarations[0].name.getText(), 'firstVirtual');
    const restoredText = virtualText;
    virtualText = undefined;
    assert.equal(makeProgram().getSourceFile(virtual), undefined, 'deleted host content must release its native overlay');
    virtualText = restoredText;
    assert.deepEqual(makeProgram().getSemanticDiagnostics(), [], 'a recreated overlay must be checked again');
    const replacement = `${textDir}/replacement.ts`;
    fs.writeFileSync(replacement, 'export const value = 2;\n');
    virtualText = virtualText.replace('./dependency', './replacement');
    const redirected = makeProgram();
    assert.deepEqual(redirected.getSemanticDiagnostics(), []);
    checkResolution(redirected, replacement);
    console.log('check:text-host ok (no duplicate parse; real AST walks; fresh disk imports and virtual text)');
}
function checkDiskPrograms(name) {
    const diskDir = path.join(dir, name);
    const root = path.join(diskDir, 'main.ts');
    const dependency = path.join(diskDir, 'dependency.ts');
    const declaration = path.join(diskDir, 'node_modules', 'external', 'index.d.ts').replaceAll('\\', '/');
    const configFilePath = path.join(diskDir, 'tsconfig.json');
    fs.mkdirSync(path.dirname(declaration), { recursive: true });
    const options = {
        strict: true, noEmit: true, types: [], target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        configFilePath,
    };
    fs.writeFileSync(configFilePath, JSON.stringify({ compilerOptions: {
        strict: true, noEmit: true, types: [], target: 'esnext', module: 'esnext', moduleResolution: 'bundler',
    }, files: ['main.ts'] }));
    let compilerHost;
    const check = (expected) => {
        const program = ts.createProgram({ rootNames: [root], options, host: compilerHost });
        const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({
            file: path.relative(diskDir, d.file?.fileName ?? '').replaceAll('\\', '/'),
            code: d.code,
            text: d.file?.text.slice(d.start, d.start + d.length),
        }));
        assert.deepEqual(diagnostics, expected, `${name}: fresh Program must observe current disk contents`);
        return program;
    };
    fs.writeFileSync(root, 'export const x: number = "bad";\n');
    check([{ file: 'main.ts', code: 2322, text: 'x' }]);
    fs.writeFileSync(root, 'export const x: number = 1;\n');
    check([]);

    // Reusing an ordinary CompilerHost also has no implicit watch contract.
    compilerHost = ts.createCompilerHost(options);
    fs.writeFileSync(root, 'import { value } from "./dependency";\nimport type { External } from "external";\nexport const x: number = value;\nexport const y: External = 1;\n');
    fs.writeFileSync(dependency, 'export const value = "bad";\n');
    fs.writeFileSync(declaration, 'export type External = number;\n');
    check([{ file: 'main.ts', code: 2322, text: 'x' }]);
    fs.writeFileSync(dependency, 'export const value = 1;\n');
    assert.match(check([]).getSourceFile(declaration).text, /External = number/);
    fs.writeFileSync(declaration, 'export type External = string;\n');
    const updated = check([{ file: 'main.ts', code: 2322, text: 'y' }]);
    assert.match(updated.getSourceFile(declaration).text, /External = string/, 'declaration AST must refresh with native diagnostics');
    fs.writeFileSync(declaration, 'export type External = number;\n');
    fs.unlinkSync(dependency);
    check([{ file: 'main.ts', code: 2307, text: '"./dependency"' }]);
    fs.writeFileSync(dependency, 'export const value = 1;\n');
    check([]);
}
