#!/usr/bin/env node
/**
 * Host-bound SourceFiles must carry the same `imports` / `moduleAugmentations`
 * as stock `Program.collectExternalModuleReferences` — the two-phase list:
 *
 *   imports = [top-level import/re-export/import-equals specifiers in statement
 *              order] ++ [dynamic import()/require()/import("x")-type specifiers
 *              in text order]
 *   moduleAugmentations = StringLiteral names of ambient-module augmentations
 *
 * Go's include-reason `index` addresses exactly this combined list
 * (getModuleNameStringLiteralAt), so a single interleaved walk shifts indices
 * (wrong specifier / out-of-range Debug.fail in explainFiles), and an empty
 * moduleAugmentations drops ambient-module reasons entirely.
 *
 * Fixture: a `<script setup>` SFC with a dynamic import placed between two
 * top-level imports, plus a `declare module` augmentation. The host (Volar)
 * virtualizes it; the bridge materializes the host-bound SourceFile via
 * ensureHostSourceFileModuleRefs, which must place `./dyn` AFTER `./b` (stock
 * two-phase) and record `aug-lib` in moduleAugmentations.
 *
 * Exit 0: ordering + moduleAugmentations match stock. Exit 1: divergence.
 *
 * Usage: node tools/triage-host-module-refs.mjs [path/to/typescript.js]
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
// Resolve the Volar host-side packages from the @vue/language-core workspace
// package (its node_modules carries @volar/typescript / @volar/language-core).
const langCoreRequire = createRequire(path.join(volarRoot, 'packages', 'language-core', 'package.json'));
const volarTs = langCoreRequire('@volar/typescript');
const volarLangCore = langCoreRequire('@volar/language-core');
const vueCore = require(path.join(volarRoot, 'packages', 'language-core', 'index.js'));

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-host-module-refs-'));
const mainVue = path.join(fixture, 'main.vue');
const configFile = path.join(fixture, 'tsconfig.json');

fs.writeFileSync(configFile, JSON.stringify({
    compilerOptions: {
        lib: ['esnext', 'dom'],
        target: 'esnext',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        jsx: 'preserve',
        allowJs: true,
        allowArbitraryExtensions: true,
        types: [],
    },
    include: ['**/*'],
}, null, 2));

fs.writeFileSync(mainVue, [
    '<script setup lang="ts">',
    "import a from './a';",
    "const p = import('./dyn');",
    "import b from './b';",
    "declare module 'aug-lib' {",
    '\texport interface Augmented {',
    '\t\tflag: boolean;',
    '\t}',
    '}',
    '</script>',
    '',
    '<template>',
    '\t<div></div>',
    '</template>',
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

    const sf = program.getSourceFile(mainVue);
    if (!sf) throw new Error('main.vue not in program');
    if (!sf.__tnbHostBound) throw new Error('main.vue was not materialized as a host-bound SourceFile');

    const imports = (sf.imports ?? []).map(i => i.text);
    const augs = (sf.moduleAugmentations ?? []).map(a => (a.kind === ts.SyntaxKind.StringLiteral ? a.text : undefined));

    const iA = imports.indexOf('./a');
    const iB = imports.indexOf('./b');
    const iDyn = imports.indexOf('./dyn');
    if (iA === -1 || iB === -1 || iDyn === -1) {
        throw new Error(`expected ./a, ./b, ./dyn in imports, got ${JSON.stringify(imports)}`);
    }
    // Stock two-phase: dynamic import lands AFTER every top-level import that
    // precedes it in the source, never interleaved before a later top-level import.
    if (iA >= iB) {
        throw new Error(`top-level import order diverged: ./a@${iA} >= ./b@${iB} in ${JSON.stringify(imports)}`);
    }
    if (iDyn <= iB) {
        throw new Error(`dynamic import interleaved before a later top-level import: ./dyn@${iDyn} <= ./b@${iB} in ${JSON.stringify(imports)}`);
    }
    if (!augs.includes('aug-lib')) {
        throw new Error(`moduleAugmentations missing aug-lib: ${JSON.stringify(augs)}`);
    }

    console.log(`check:host-module-refs ok imports=${JSON.stringify(imports)} augs=${JSON.stringify(augs)}`);
}
finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}
