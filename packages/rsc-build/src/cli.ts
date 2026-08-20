import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  inspectRscPluginArtifact,
  resolveRscPluginArtifact,
  resolveVerifiedRscPluginArtifact,
} from '@hile/rsc/artifact';
import { HILE_RSC_RUNTIME, type RscRuntimeCompatibility } from '@hile/rsc/protocol';
import {
  buildRscPlugin,
  loadRscBuildConfig,
} from './index';

export interface RscCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

const USAGE = `Usage:
  hile-rsc build [--config <hile-rsc.json|js|mjs>]
  hile-rsc inspect [artifact-directory|plugin.json]
  hile-rsc verify [artifact-directory|plugin.json] [--react <version> --react-dom <version> --rsc <version>]
`;

class UsageError extends Error {}

type BuildIdSource = 'manual' | 'environment' | 'automatic';

function safeBuildId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError('RSC buildId must be a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new TypeError('RSC buildId contains unsupported characters');
  }
  return trimmed;
}

function generateBuildId(): string {
  return `build-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function resolveBuildId(raw: string | undefined): { buildId: string; source: BuildIdSource } {
  const manual = safeBuildId(raw);
  if (manual) return { buildId: manual, source: 'manual' };
  const env = safeBuildId(process.env.RSC_BUILD_ID);
  if (env) return { buildId: env, source: 'environment' };
  return { buildId: generateBuildId(), source: 'automatic' };
}

function resolveOutdir(outdir: string, buildId: string, source: BuildIdSource): string {
  if (source === 'manual') return outdir;
  const base = path.basename(outdir);
  if (base === buildId) return outdir;
  return path.join(outdir, buildId);
}

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

function runtimeOptions(args: string[]): RscRuntimeCompatibility {
  if (args.length === 0) return HILE_RSC_RUNTIME;
  assertExactOptions(args, ['--react', '--react-dom', '--rsc']);
  return {
    react: requiredOption(args, '--react'),
    reactDom: requiredOption(args, '--react-dom'),
    rsc: requiredOption(args, '--rsc'),
  };
}

async function execute(args: string[], io: RscCliIo, cwd: string): Promise<void> {
  const [command, ...rest] = args;
  if ((command === '--help' || command === '-h' || command === 'help') && rest.length === 0) {
    io.stdout(USAGE);
    return;
  }
  if (command === 'build') {
    if (rest.length > 0) assertExactOptions(rest, ['--config']);
    const configPath = path.resolve(cwd, rest.length > 0 ? requiredOption(rest, '--config') : 'hile-rsc.json');
    const options = await loadRscBuildConfig(configPath);
    const { buildId, source } = resolveBuildId(options.buildId);
    const effectiveOutdir = resolveOutdir(options.outdir, buildId, source);
    const manifest = await buildRscPlugin({
      ...options,
      buildId,
      outdir: effectiveOutdir,
    });
    writeJson(io, {
      command,
      pluginId: manifest.pluginId,
      buildId: manifest.buildId,
      artifact: path.resolve(effectiveOutdir),
      metadata: manifest.metadata,
    });
    return;
  }
  if (command === 'inspect') {
    if (rest.length > 1 || rest[0]?.startsWith('--')) throw new UsageError('inspect accepts at most one artifact');
    const artifact = await resolveRscPluginArtifact(path.resolve(cwd, rest[0] ?? '.hile-rsc'), {
      buildId: safeBuildId(process.env.RSC_BUILD_ID),
    });
    const manifest = await inspectRscPluginArtifact(artifact);
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
    const hasArtifact = rest[0] !== undefined && !rest[0].startsWith('--');
    const artifact = hasArtifact ? rest[0] : '.hile-rsc';
    const runtime = runtimeOptions(hasArtifact ? rest.slice(1) : rest);
    const verification = await resolveVerifiedRscPluginArtifact(
      path.resolve(cwd, artifact),
      runtime,
      { buildId: safeBuildId(process.env.RSC_BUILD_ID) },
    );
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

export async function runRscCli(args: string[], io: RscCliIo, cwd = process.cwd()): Promise<number> {
  try {
    await execute(args, io, cwd);
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
