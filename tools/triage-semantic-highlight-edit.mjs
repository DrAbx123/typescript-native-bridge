#!/usr/bin/env node
/**
 * Semantic-highlight edit witness: a tsserver content edit must not leave the
 * JS-side host SourceFile cache stale.
 *
 * The thin program is reused across content-only edits (__tnbSyncOverlay pushes
 * the new text to Go via updateSnapshot), but the JS-side host SourceFile
 * caches (sfCache / fullSfByName) keyed on host.getScriptVersion — which the
 * tsserver compiler host reports as a constant — were not invalidated. The next
 * getSourceFile therefore served the OLD host AST/text against the freshly
 * advanced Go snapshot, so encodedSemanticClassifications walked stale
 * positions: spans dropped (or misaligned) right after an edit.
 *
 * This witness asserts that after a single-char insert the semantic span count
 * is unchanged and every span shifts by exactly the inserted width.
 *
 * Usage: node tools/triage-semantic-highlight-edit.mjs
 * Exit: 0 = PASS.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tnbHarnessEnv, withTsserver } from './tsserver-harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tnbPath = path.join(repoRoot, 'lib', 'tsserver.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-sem-hl-'));
const mainTs = path.join(dir, 'main.ts');
fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'es2022' },
    include: ['*.ts'],
}));
const depTs = path.join(dir, 'dep.ts');
fs.writeFileSync(depTs, 'export const x: number = 1;\n');
const v0 = `import { x } from './dep';\nconst foo: number = x;\nfunction bar(a: string) { return a.length; }\nexport const z = foo + bar('hi');\n`;
fs.writeFileSync(mainTs, v0);

const CMD = 30_000;
let bad = 0;
const fail = msg => { bad++; console.error(`FAIL ${msg}`); };

const spansOf = async (send, length) => {
    const r = await send('encodedSemanticClassifications-full', { file: mainTs, start: 0, length, format: '2020' }, CMD);
    if (!r?.success) { fail(`encodedSemanticClassifications-full unsuccessful: ${r?.message}`); return []; }
    return r?.body?.spans ?? [];
};

await withTsserver(
    { tsserverPath: tnbPath, args: ['--disableAutomaticTypingAcquisition', '--suppressDiagnosticEvents'], env: tnbHarnessEnv(), deadlineMs: 5 * 60 * 1000 },
    async ({ send }) => {
        await send('updateOpen', { changedFiles: [], closedFiles: [], openFiles: [
            { file: mainTs, fileContent: v0, projectRootPath: dir },
            { file: depTs, fileContent: fs.readFileSync(depTs, 'utf8'), projectRootPath: dir },
        ] }, CMD);

        const before = await spansOf(send, v0.length);
        if (before.length === 0) fail(`no semantic spans before edit: ${JSON.stringify(before)}`);

        // Insert one space at the very start (line 1, offset 1) — every token
        // after it shifts by exactly one UTF-16 code unit.
        await send('change', { file: mainTs, line: 1, offset: 1, endLine: 1, endOffset: 1, insertString: ' ' }, CMD);
        const after = await spansOf(send, v0.length + 1);

        if (after.length !== before.length) {
            fail(`span count changed after edit: before=${before.length} after=${after.length}`);
        }
        else if (after.length === 0) {
            fail('no semantic spans after edit');
        }
        else {
            // Every span start must shift by exactly the inserted width (1).
            const shifted = after.every((s, i) => i % 3 !== 0 || s === before[i] + 1);
            if (!shifted) {
                fail(`spans did not shift by the edit delta: before=${JSON.stringify(before.slice(0, 9))} after=${JSON.stringify(after.slice(0, 9))}`);
            }
            else {
                console.log(`ok semantic spans preserved and shifted (count=${after.length})`);
            }
        }
    },
);

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad === 0 ? 'VERDICT: PASS' : 'VERDICT: FAIL');
process.exit(bad === 0 ? 0 : 1);
