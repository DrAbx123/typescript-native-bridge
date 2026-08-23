#!/usr/bin/env node
/**
 * symbolToParameterDeclaration must not forward a non-function-like tsgo node
 * to getSignatureFromDeclaration.
 *
 * The type-tree plugin (`@ts-type-explorer`) calls symbolToParameterDeclaration
 * on every symbol. For a transient property symbol (e.g. `bar.value` where
 * `bar` is a string, so `value` has no real declaration), the symbol's
 * valueDeclaration is a synthetic PropertySignature whose parent is a
 * TypeLiteral. findTsgoNodeAtPosition falls back to the innermost node on a
 * kind miss, so the adapter used to pass that TypeLiteral into
 * getSignatureFromDeclaration, whose Go side unconditionally reads
 * .Parameters() → nil deref → SIGABRT.
 *
 * Exit 0: symbolToParameterDeclaration skips the non-function-like parent.
 * Exit != 0: it crashes (Go panic) or throws.
 *
 * Usage: node tools/triage-symbol-to-param-guard.mjs [path/to/typescript.js]
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

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-symbol-to-param-'));
const mainVue = path.join(fixture, 'main.vue');
const configFile = path.join(fixture, 'tsconfig.json');

fs.writeFileSync(configFile, JSON.stringify({
    compilerOptions: {
        lib: ['esnext'],
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowJs: true,
        allowArbitraryExtensions: true,
        types: [],
    },
    include: ['**/*'],
}, null, 2));

fs.writeFileSync(mainVue, [
    '<script setup lang="ts">',
    'declare function withDotValue<T, Ref>(t: T, ref: Ref): asserts t is T & { value: T }',
    "const bar = 'bar';",
    'withDotValue(bar, {} as { bar: any });',
    'bar.value;',
    '</script>',
    '',
    '<template><div></div></template>',
    '',
].join('\n'));

try {
    const parsed = vueCore.createParsedCommandLine(ts, ts.sys, configFile);
    const { vueOptions, options, projectReferences } = parsed;
    const fileNames = [...new Set([...(parsed.fileNames ?? []), mainVue])];
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
    // Find the `value` identifier in `bar.value` (line 2, after the dot).
    const sf = program.getSourceFile(mainVue);
    const text = sf.text;
    const dotIdx = text.indexOf('bar.value');
    if (dotIdx === -1) throw new Error('bar.value not found in fixture');
    const valueIdx = dotIdx + 'bar.'.length;
    const pos = sf.getPositionOfLineAndCharacter ? null : valueIdx;

    // Locate the value identifier via a token walk (position-based).
    let valueNode;
    const valuePos = valueIdx;
    function walk(node) {
        if (valueNode) return;
        if (node.kind === ts.SyntaxKind.Identifier && node.getStart(sf) === valuePos) {
            valueNode = node;
            return;
        }
        ts.forEachChild(node, walk);
    }
    walk(sf);

    if (!valueNode) throw new Error('value identifier not found');
    const symbol = checker.getSymbolAtLocation(valueNode);
    if (!symbol) throw new Error('no symbol for bar.value');

    // The crash path: symbolToParameterDeclaration on a transient property
    // symbol whose declaration parent is a TypeLiteral.
    const result = checker.symbolToParameterDeclaration(symbol, undefined, undefined);
    // Either a node or undefined is acceptable — the contract is "no crash".
    console.log(`check:symbol-to-param-guard ok (result=${result ? 'node' : 'undefined'})`);
}
finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}
