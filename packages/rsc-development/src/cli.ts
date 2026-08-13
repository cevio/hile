import path from 'node:path';
import { loadRscBuildConfig } from '@hile/rsc-build';
import { createRscDevelopmentProject } from './project';

const USAGE = 'Usage: hile-rsc-dev --config <file> --state <file> --namespace <name> --outdir <directory>\n';

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new TypeError(`Missing ${name}`);
  return value;
}

export async function runRscDevelopmentCli(args: string[]): Promise<number> {
  if (args.length !== 8) {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    const configFile = path.resolve(option(args, '--config'));
    const project = await createRscDevelopmentProject({
      configFile,
      stateFile: path.resolve(option(args, '--state')),
      namespace: option(args, '--namespace'),
      outdir: path.resolve(option(args, '--outdir')),
      loadConfig: () => loadRscBuildConfig(configFile),
      onRevision(revision) {
        process.stdout.write(`${JSON.stringify({
          pluginId: revision.manifest.pluginId,
          buildId: revision.manifest.buildId,
          revision: revision.revision,
          artifact: revision.artifactRoot,
          contexts: revision.contexts,
        })}\n`);
      },
      onError(error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      },
    });
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await project.dispose();
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 1;
  }
}
