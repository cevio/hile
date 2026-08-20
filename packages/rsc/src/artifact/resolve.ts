import { access, lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { RscRuntimeCompatibility } from '../protocol';
import {
  inspectRscPluginArtifact,
  verifyRscPluginArtifact,
  type RscArtifactVerification,
} from './verify';

export interface ResolveRscPluginArtifactOptions {
  buildId?: string;
}

export interface ResolvedVerifiedRscPluginArtifact extends RscArtifactVerification {
  artifactRoot: string;
}

function safeBuildId(value: string | undefined): string | undefined {
  const buildId = value?.trim();
  if (!buildId) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(buildId)) {
    throw new TypeError('RSC buildId contains unsupported characters');
  }
  return buildId;
}

async function resolveCandidate(
  input: string,
  options: ResolveRscPluginArtifactOptions,
  hostRuntime?: RscRuntimeCompatibility,
): Promise<{ artifactRoot: string; verification?: RscArtifactVerification }> {
  const root = path.resolve(input);
  try {
    const value = await lstat(root);
    if (!value.isDirectory()) return { artifactRoot: root };
    await access(path.join(root, 'plugin.json'));
    return { artifactRoot: root };
  } catch {
    // A build root is resolved below.
  }
  const buildId = safeBuildId(options.buildId);
  if (buildId) return { artifactRoot: path.join(root, buildId) };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { artifactRoot: root };
  }
  const candidates = (await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'development')
    .map(async (entry) => {
      const candidatePath = path.join(root, entry.name);
      const manifestPath = path.join(candidatePath, 'plugin.json');
      try {
        const mtime = (await stat(manifestPath)).mtimeMs;
        try {
          const manifest = await inspectRscPluginArtifact(candidatePath);
          return { path: candidatePath, name: entry.name, mtime, manifest };
        } catch (error) {
          return { path: candidatePath, name: entry.name, mtime, error };
        }
      } catch {
        return undefined;
      }
    })))
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
    .sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name));
  let firstError: unknown;
  for (const candidate of candidates) {
    if ('error' in candidate) {
      firstError ??= candidate.error;
      continue;
    }
    try {
      const verification = await verifyRscPluginArtifact(
        candidate.path,
        hostRuntime ?? candidate.manifest.runtime,
      );
      return { artifactRoot: candidate.path, verification };
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
  return { artifactRoot: root };
}

/** Resolves either one artifact directory or a build root containing immutable artifacts. */
export async function resolveRscPluginArtifact(
  input: string,
  options: ResolveRscPluginArtifactOptions = {},
): Promise<string> {
  return (await resolveCandidate(input, options)).artifactRoot;
}

/** Resolves and verifies an artifact once, reusing candidate verification for build roots. */
export async function resolveVerifiedRscPluginArtifact(
  input: string,
  hostRuntime: RscRuntimeCompatibility,
  options: ResolveRscPluginArtifactOptions = {},
): Promise<ResolvedVerifiedRscPluginArtifact> {
  const resolved = await resolveCandidate(input, options, hostRuntime);
  const verification = resolved.verification
    ?? await verifyRscPluginArtifact(resolved.artifactRoot, hostRuntime);
  return {
    artifactRoot: resolved.artifactRoot,
    ...verification,
  };
}
