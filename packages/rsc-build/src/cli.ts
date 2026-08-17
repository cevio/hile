import path from 'node:path';
import { inspectRscPluginArtifact, verifyRscPluginArtifact } from '@hile/rsc/artifact';
import {
  buildRscPlugin,
  loadRscBuildConfig,
} from './index';

export interface RscCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const USAGE = `Usage:
  hile-rsc build --config <hile-rsc.json|js|mjs>
  hile-rsc inspect <artifact-directory|plugin.json>
  hile-rsc verify <artifact-directory|plugin.json> --react <version> --react-dom <version> --rsc <version>
`;

class UsageError extends Error {}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new UsageError(`Missing ${name}`);
  return value;
}

function assertExactOptions(args: string[], names: string[], positional = 0): void {
  if (args.length !== positional + names.length * 2) throw new UsageError('Unexpected or missing arguments');
  const seen = new Set<string>();
  for (let index = positional; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!names.includes(name) || seen.has(name) || !value || value.startsWith('--')) {
      throw new UsageError(`Invalid option: ${name ?? '<missing>'}`);
    }
    seen.add(name);
  }
  if (seen.size !== names.length) throw new UsageError('Missing required options');
}

function writeJson(io: RscCliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function execute(args: string[], io: RscCliIo): Promise<void> {
  const [command, ...rest] = args;
  if ((command === '--help' || command === '-h' || command === 'help') && rest.length === 0) {
    io.stdout(USAGE);
    return;
  }
  if (command === 'build') {
    assertExactOptions(rest, ['--config']);
    const configPath = requiredOption(rest, '--config');
    const options = await loadRscBuildConfig(configPath);
    const manifest = await buildRscPlugin(options);
    writeJson(io, {
      command,
      pluginId: manifest.pluginId,
      buildId: manifest.buildId,
      artifact: path.resolve(options.outdir),
      metadata: manifest.metadata,
    });
    return;
  }
  if (command === 'inspect') {
    if (rest.length !== 1 || rest[0].startsWith('--')) throw new UsageError('inspect requires one artifact');
    const manifest = await inspectRscPluginArtifact(rest[0]);
    writeJson(io, {
      command,
      pluginId: manifest.pluginId,
      buildId: manifest.buildId,
      runtime: manifest.runtime,
      routes: manifest.routes,
      metadata: manifest.metadata,
      clients: manifest.clients.length,
      styles: manifest.styles.length,
    });
    return;
  }
  if (command === 'verify') {
    const artifact = rest[0];
    if (!artifact || artifact.startsWith('--')) throw new UsageError('verify requires an artifact');
    assertExactOptions(rest, ['--react', '--react-dom', '--rsc'], 1);
    const runtime = {
      react: requiredOption(rest, '--react'),
      reactDom: requiredOption(rest, '--react-dom'),
      rsc: requiredOption(rest, '--rsc'),
    };
    const verification = await verifyRscPluginArtifact(artifact, runtime);
    writeJson(io, {
      command,
      valid: true,
      pluginId: verification.manifest.pluginId,
      buildId: verification.manifest.buildId,
      metadata: verification.manifest.metadata,
      files: verification.files.length,
    });
    return;
  }
  throw new UsageError(command ? `Unknown command: ${command}` : 'Missing command');
}

export async function runRscCli(args: string[], io: RscCliIo): Promise<number> {
  try {
    await execute(args, io);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n${USAGE}`);
      return 2;
    }
    io.stderr(`${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    return 1;
  }
}
