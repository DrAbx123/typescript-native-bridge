#!/usr/bin/env node
/**
 * getTypeOfSymbol must never return undefined.
 *
 * Stock's getTypeOfSymbol (checker.ts:12960) always returns a Type: value/
 * function/class/… kinds compute a type, every other kind falls through to
 * errorType. The rpc() facade returns undefined for a host-only symbol (no tsgo
 * counterpart), and the adapter leaked that verbatim (and memoized it), so the
 * type-tree plugin (`@ts-type-explorer`) crashed on `'intrinsicName' in type`.
 *
 * A host-only symbol has no checker on either side — the host binder produces
 * symbols, not types — so errorType is the faithful answer for the reachable
 * declaration-less shape (flags 0 → stock fallthrough) and the honest "unknown"
 * sentinel otherwise.
 *
 * Usage: node tools/triage-type-of-symbol-hostonly.mjs [path/to/typescript.js]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const typescriptPath = path.resolve(process.argv[2] ?? path.join(repoRoot, 'lib', 'typescript.js'));
const ts = require(typescriptPath);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tnb-type-of-symbol-'));

function write(relativePath, content) {
    const fileName = path.join(fixture, relativePath);
    fs.writeFileSync(fileName, content);
    return fileName;
}

write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true }, include: ['main.ts'] }));
const mainFile = write('main.ts', 'export const value = 1;\n');

const logger = {
    hasLevel: () => false,
    loggingEnabled: () => false,
    write: () => {},
    writeLogFile: () => {},
    info: () => {},
    msg: () => {},
    verbose: () => {},
    startGroup: () => {},
    endGroup: () => {},
    getLevel: () => 0,
};

const service = new ts.server.ProjectService({
    host: {
        getCurrentDirectory: () => fixture,
        getExecutingFilePath: () => path.join(path.dirname(typescriptPath), 'tsserver.js'),
        getNodeMajorVersion: () => process.versions.node.split('.')[0],
        getScriptSnapshot: fileName => fs.existsSync(fileName)
            ? ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'))
            : undefined,
        getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
        getNewLine: () => '\n',
        watchFile: () => ts.Noop,
        watchDirectory: () => ts.Noop,
    },
    logger,
    cancellationToken: ts.server.nullCancellationToken,
    useSingleInferredProject: false,
    useInferredProjectPerProjectRoot: false,
});

function isTypeLike(value) {
    return value != null
        && (typeof value.getFlags === 'function' || typeof value.flags === 'number');
}

try {
    service.openClientFile(mainFile, 'export const value = 1;\n', ts.ScriptKind.TS);
    const [project] = [...service.configuredProjects.values()];
    const languageService = project.getLanguageService();
    const program = languageService.getProgram();
    const checker = program.getTypeChecker();

    // Sanity: a real, tsgo-backed value symbol resolves to a concrete type.
    const sf = program.getSourceFile(mainFile);
    const valueNode = sf.statements[0].declarationList.declarations[0].name;
    const realSymbol = checker.getSymbolAtLocation(valueNode);
    if (!realSymbol) throw new Error('real symbol missing');
    const realType = checker.getTypeOfSymbol(realSymbol);
    if (realType === undefined || realType === null) {
        throw new Error('real symbol leaked undefined from getTypeOfSymbol');
    }
    if (!isTypeLike(realType)) {
        throw new Error(`getTypeOfSymbol returned non-Type for a real symbol: ${typeof realType}`);
    }

    // Host-only symbol: no declarations / valueDeclaration to map to a tsgo
    // counterpart. The type-tree plugin hands exactly this shape back into
    // getTypeOfSymbol after getSymbolAtLocation on a host-bound file.
    const hostOnlySymbol = {
        escapedName: '__tnbHostOnly',
        flags: 0,
        declarations: undefined,
        valueDeclaration: undefined,
    };
    const type = checker.getTypeOfSymbol(hostOnlySymbol);
    if (type === undefined || type === null) {
        throw new Error('getTypeOfSymbol leaked undefined for a host-only symbol');
    }
    if (!isTypeLike(type)) {
        throw new Error(`getTypeOfSymbol returned non-Type for a host-only symbol: ${typeof type}`);
    }
    const flags = typeof type.getFlags === 'function' ? type.getFlags() : type.flags;
    // Stock getTypeOfSymbol(flags:0) falls through to errorType (TypeFlags.Any
    // with intrinsicName "error") — the bridge must converge to the same sentinel.
    if (flags !== ts.TypeFlags.Any || type.intrinsicName !== 'error') {
        throw new Error(
            `getTypeOfSymbol returned non-errorType for a host-only flags:0 symbol: flags=${flags} intrinsicName=${type.intrinsicName}`,
        );
    }

    console.log(`check:type-of-symbol-hostonly ok (real=${realType.flags}, hostOnly=${flags} ${type.intrinsicName})`);
}
finally {
    fs.rmSync(fixture, { recursive: true, force: true });
}
