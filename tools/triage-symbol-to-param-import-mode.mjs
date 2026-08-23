#!/usr/bin/env node
/**
 * symbolToParameterDeclaration must not forward a nil enclosingDeclaration to
 * Go when the parameter's declared type references an external module.
 *
 * The type-tree plugin (`@ts-type-explorer`) calls
 * `symbolToParameterDeclaration(parameter, undefined)` to probe a property /
 * parameter's optional/rest shape. Stock's NodeBuilder accepts a nil enclosing
 * declaration: when it serializes an `import("…")` type it only reads the
 * enclosing declaration's source file lazily and guards the nil with optional
 * chaining (checker.ts `contextFile?.impliedNodeFormat`). tsgo's port drops
 * that guard — `symbolToTypeNode` calls
 * `GetEmitModuleFormatOfFile(GetSourceFileOfNode(enclosingDeclaration))`
 * unconditionally (nodebuilderimpl.go:678) and nil-derefs when the enclosing
 * declaration is absent, but only once the module specifier contains
 * `/node_modules/` (so `getSpecifierForModuleSymbol` produced a file path
 * rather than a bare name).
 *
 * This harness reproduces that exact shape without the plugin: a `node16`
 * fixture whose parameter type is `typeof pkg` for a type imported from a
 * `node_modules` package, then `symbolToParameterDeclaration(ctx, undefined)`.
 *
 * Exit 0: the call returns (a node or undefined) without a Go panic.
 * Exit != 0: it crashes (SIGABRT) or throws.
 *
 * Usage: node tools/triage-symbol-to-param-import-mode.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVolarRoot } from './volar-root.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typescriptPath = path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js'));
const volarRoot = resolveVolarRoot();

const ts = require(typescriptPath);
const langCoreRequire = createRequire(path.join(volarRoot, 'packages', 'language-core', 'package.json'));
const volarTs = langCoreRequire('@volar/typescript');
const volarLangCore = langCoreRequire('@volar/language-core');
const vueCore = require(path.join(volarRoot, 'packages', 'language-core', 'index.js'));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-symbol-to-param-import-mode-'));
const pkgDir = path.join(fixture, 'node_modules', 'some-pkg');
const mainTs = path.join(fixture, 'main.ts');
const configFile = path.join(fixture, 'tsconfig.json');

try {
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: 'some-pkg',
        version: '1.0.0',
        types: 'index.d.ts',
    }, null, 2));
    fs.writeFileSync(path.join(pkgDir, 'index.d.ts'), 'export interface Foo { value: string }\n');

    fs.writeFileSync(mainTs, [
        "import type * as pkg from 'some-pkg';",
        'export type Plugin = (ctx: { modules: { some: typeof pkg } }) => void;',
    ].join('\n'));

    fs.writeFileSync(configFile, JSON.stringify({
        compilerOptions: {
            module: 'node16',
            moduleResolution: 'node16',
            target: 'esnext',
            lib: ['esnext'],
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: [],
        },
        include: ['main.ts'],
    }, null, 2));

    const parsed = vueCore.createParsedCommandLine(ts, ts.sys, configFile);
    const { vueOptions, options, projectReferences } = parsed;
    const fileNames = [...new Set([...(parsed.fileNames ?? []), mainTs])];
    let projectVersion = 0;
    const scriptSnapshots = new Map();
    const projectHost = {
        getCurrentDirectory: () => fixture,
        getProjectVersion: () => projectVersion.toString(),
        getCompilationSettings: () => options,
        getScriptFileNames: () => fileNames,
        getProjectReferences: () => projectReferences,
    };
    const vueLanguagePlugin = vueCore.createVueLanguagePlugin(ts, options, vueOptions, id => id);
    const language = volarLangCore.createLanguage(
        [vueLanguagePlugin, { getLanguageId: f => volarTs.resolveFileLanguageId(f) }],
        new volarLangCore.FileMap(ts.sys.useCaseSensitiveFileNames),
        fileName => {
            if (!scriptSnapshots.has(fileName)) {
                const text = ts.sys.readFile(fileName);
                scriptSnapshots.set(fileName, text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined);
            }
            const snap = scriptSnapshots.get(fileName);
            if (snap) language.scripts.set(fileName, snap);
            else language.scripts.delete(fileName);
        },
    );
    const { languageServiceHost } = volarTs.createLanguageServiceHost(ts, ts.sys, language, s => s, projectHost);
    const program = ts.createLanguageService(languageServiceHost).getProgram();
    if (!program) throw new Error('no program');

    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(mainTs);
    if (!sf) throw new Error('main.ts not in program');

    // Locate the `Plugin` type alias name (declared in main.ts above).
    let aliasNode;
    function walk(node) {
        if (aliasNode) return;
        if (node.kind === ts.SyntaxKind.TypeAliasDeclaration && node.name?.text === 'Plugin') {
            aliasNode = node.name;
            return;
        }
        ts.forEachChild(node, walk);
    }
    walk(sf);
    if (!aliasNode) throw new Error('Plugin type alias not found');

    const aliasSymbol = checker.getSymbolAtLocation(aliasNode);
    if (!aliasSymbol) throw new Error('no symbol for Plugin type alias');

    const fnType = checker.getDeclaredTypeOfSymbol(aliasSymbol);
    const signatures = checker.getSignaturesOfType(fnType, ts.SignatureKind.Call);
    const ctxParam = signatures?.[0]?.getParameters?.()?.[0];
    if (!ctxParam) throw new Error('no ctx parameter on Plugin signature');

    // The crash path: symbolToParameterDeclaration on a parameter whose declared
    // type references a node_modules module, with a nil enclosing declaration.
    const result = checker.symbolToParameterDeclaration(ctxParam, undefined, undefined);
    // Either a node or undefined is acceptable — the contract is "no crash".
    console.log(`check:symbol-to-param-import-mode ok (result=${result ? 'node' : 'undefined'})`);
}
finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}
