import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build as nativeBuild, type OnResolveArgs, type PluginBuild } from 'esbuild';
import ts from 'typescript';

/** Checks ambiguous exclusions through esbuild without executing source or emitting artifacts. */
export function createBrowserExclusionCheck(build: PluginBuild) {
  const browserExclusions = new Map<string, Promise<boolean | undefined>>();
  const disabledImports = new Map<string, Promise<boolean>>();
  const isBrowserDisabled = async (canonical: string, args: OnResolveArgs): Promise<boolean> => {
    if (build.initialOptions.platform !== 'browser') return false;
    let hasExclusions = false;
    for (let directory of new Set([path.dirname(canonical), args.resolveDir])) {
      while (true) {
        const packageJson = ts.findConfigFile(directory, ts.sys.fileExists, 'package.json');
        if (!packageJson) break;
        let excluded = browserExclusions.get(packageJson);
        if (!excluded) {
          excluded = readFile(packageJson, 'utf8').then((source) => {
            const { browser } = JSON.parse(source.replace(/^\uFEFF/, ''));
            return browser && typeof browser === 'object' && !Array.isArray(browser)
              ? Object.values(browser).includes(false)
              : undefined;
          });
          browserExclusions.set(packageJson, excluded);
        }
        const result = await excluded;
        if (result !== undefined) {
          hasExclusions ||= result;
          break;
        }
        const parent = path.dirname(path.dirname(packageJson));
        if (parent === directory) break;
        directory = parent;
      }
    }
    if (!hasExclusions) return false;
    const key = JSON.stringify([args.path, args.resolveDir, args.kind]);
    let disabled = disabledImports.get(key);
    if (!disabled) {
      disabled = (async () => {
        try {
          // The public resolve API omits the disabled flag. Confirm it using native input sizes.
          const result = await nativeBuild({
            ...build.initialOptions,
            plugins: [],
            entryPoints: undefined,
            outfile: undefined,
            globalName: undefined,
            stdin: {
              contents: args.kind === 'require-call' || args.kind === 'require-resolve'
                ? `module.exports = require(${JSON.stringify(args.path)});`
                : `export * as dependency from ${JSON.stringify(args.path)};`,
              resolveDir: args.resolveDir,
            },
            bundle: true,
            splitting: false,
            format: 'cjs',
            write: false,
            metafile: true,
            treeShaking: false,
            logLevel: 'silent',
          });
          const inputs = Object.entries(result.metafile!.inputs).filter(([file]) => file !== '<stdin>');
          return inputs.length > 0 && inputs.every(([, input]) => input.bytes === 0);
        } catch {
          return false;
        }
      })();
      disabledImports.set(key, disabled);
    }
    return disabled;
  };
  build.onStart(() => {
    browserExclusions.clear();
    disabledImports.clear();
  });
  return isBrowserDisabled;
}
