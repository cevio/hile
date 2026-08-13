import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  validateRscPluginManifest,
  type RscPluginManifest,
  type RscRuntimeCompatibility,
} from '../protocol';

export interface RscArtifactVerification {
  manifest: RscPluginManifest;
  files: string[];
}

async function resolveManifestPath(input: string): Promise<{ root: string; manifestPath: string }> {
  const absolute = path.resolve(input);
  const value = await lstat(absolute);
  if (value.isSymbolicLink()) throw new Error(`RSC artifact input must not be a symbolic link: ${absolute}`);
  if (value.isDirectory()) {
    const manifestPath = path.join(absolute, 'plugin.json');
    const manifestFile = await lstat(manifestPath);
    if (!manifestFile.isFile() || manifestFile.isSymbolicLink()) {
      throw new Error(`RSC artifact manifest must be a regular file: ${manifestPath}`);
    }
    return { root: absolute, manifestPath };
  }
  if (!value.isFile()) throw new Error(`RSC artifact manifest is not a file: ${absolute}`);
  return { root: path.dirname(absolute), manifestPath: absolute };
}

async function assertRegularArtifact(root: string, artifactPath: string) {
  let current = root;
  const segments = artifactPath.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let value;
    try {
      value = await lstat(current);
    } catch {
      throw new Error(`RSC artifact is missing: ${artifactPath}`);
    }
    if (value.isSymbolicLink()) {
      throw new Error(`RSC artifact must not traverse a symbolic link: ${artifactPath}`);
    }
    if (index < segments.length - 1 && !value.isDirectory()) {
      throw new Error(`RSC artifact parent must be a directory: ${artifactPath}`);
    }
    if (index === segments.length - 1 && !value.isFile()) {
      throw new Error(`RSC artifact must be a regular file: ${artifactPath}`);
    }
  }
  return current;
}

async function listArtifactFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      throw new Error(`RSC artifact must not contain a symbolic link: ${relative}`);
    }
    if (entry.isDirectory()) files.push(...await listArtifactFiles(root, absolute));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`RSC artifact contains an unsupported filesystem entry: ${relative}`);
  }
  return files;
}

export async function inspectRscPluginArtifact(input: string): Promise<RscPluginManifest> {
  const { manifestPath } = await resolveManifestPath(input);
  const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as { runtime?: RscRuntimeCompatibility };
  if (!raw.runtime) throw new Error('RSC artifact manifest is missing runtime compatibility');
  return validateRscPluginManifest(raw, raw.runtime);
}

function expectedFiles(manifest: RscPluginManifest): Map<string, string> {
  const files = new Map<string, string>();
  const add = (artifactPath: string, integrity: string) => {
    const previous = files.get(artifactPath);
    if (previous && previous !== integrity) {
      throw new Error(`RSC artifact declares conflicting integrity: ${artifactPath}`);
    }
    files.set(artifactPath, integrity);
  };
  add(manifest.server.entry, manifest.server.integrity);
  for (const client of manifest.clients) {
    add(client.module, client.integrity);
    add(client.ssrModule, client.ssrIntegrity);
    for (const chunk of client.chunks) add(chunk.path, chunk.integrity);
    for (const chunk of client.ssrChunks) add(chunk.path, chunk.integrity);
  }
  for (const style of manifest.styles) add(style.path, style.integrity);
  return files;
}

export async function verifyRscPluginArtifact(
  input: string,
  hostRuntime: RscRuntimeCompatibility,
): Promise<RscArtifactVerification> {
  const { root, manifestPath } = await resolveManifestPath(input);
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  const manifest = validateRscPluginManifest(raw, hostRuntime);
  const files = expectedFiles(manifest);
  for (const [artifactPath, expectedIntegrity] of files) {
    const absolute = path.resolve(root, artifactPath);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error(`RSC artifact escapes its root: ${artifactPath}`);
    }
    await assertRegularArtifact(root, artifactPath);
    const actualIntegrity = `sha256-${createHash('sha256').update(await readFile(absolute)).digest('base64')}`;
    if (actualIntegrity !== expectedIntegrity) {
      throw new Error(`RSC artifact integrity mismatch: ${artifactPath}`);
    }
  }
  const manifestArtifactPath = path.relative(root, manifestPath).split(path.sep).join('/');
  const declared = new Set([manifestArtifactPath, ...files.keys()]);
  for (const artifactPath of await listArtifactFiles(root)) {
    if (!declared.has(artifactPath)) {
      throw new Error(`RSC artifact contains an undeclared file: ${artifactPath}`);
    }
  }
  return { manifest, files: [...files.keys()].sort() };
}
