import { getRegistryConfigsDir, namespaceToConfigFile, parseConfigFilename } from '@hile/micro';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import YAML from 'yaml';

function parseValue(raw: string): any {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/^\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (y/N) `, answer => {
      rl.close();
      resolve(answer === 'y' || answer === 'Y');
    });
  });
}

export async function listConfigs(): Promise<void> {
  const dir = getRegistryConfigsDir();
  if (!existsSync(dir)) {
    console.log('No configs found.');
    return;
  }
  const namespaces = readdirSync(dir)
    .map(f => parseConfigFilename(f))
    .filter((f): f is string => f !== null);
  if (namespaces.length === 0) {
    console.log('No configs found.');
    return;
  }
  console.log(`Configs in ${dir}:`);
  for (const ns of namespaces) {
    console.log(`  ${ns}`);
  }
}

export async function getConfig(namespace: string, json?: boolean): Promise<void> {
  const file = namespaceToConfigFile(namespace);
  if (!existsSync(file)) {
    console.error(`Config '${namespace}' not found.`);
    process.exit(1);
  }
  const config = YAML.parse(readFileSync(file, 'utf8'));
  if (json) {
    console.log(JSON.stringify(config, null, 2));
  } else {
    console.log(YAML.stringify(config));
  }
}

export async function setConfig(namespace: string, keyvalue: string): Promise<void> {
  const eqIdx = keyvalue.indexOf('=');
  if (eqIdx <= 0) {
    console.error('Invalid format. Use: set <namespace> <key>=<value>');
    process.exit(1);
  }
  const key = keyvalue.slice(0, eqIdx);
  const value = parseValue(keyvalue.slice(eqIdx + 1));

  const file = namespaceToConfigFile(namespace);
  mkdirSync(getRegistryConfigsDir(), { recursive: true });
  let config: Record<string, any> = {};
  if (existsSync(file)) {
    const raw = YAML.parse(readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null) config = raw;
  }
  config[key] = value;
  writeFileSync(file, YAML.stringify(config), 'utf8');
  console.log(`Set ${namespace}.${key} = ${JSON.stringify(value)}`);
}

export async function delConfig(namespace: string, key?: string, yes?: boolean): Promise<void> {
  const file = namespaceToConfigFile(namespace);
  if (!existsSync(file)) {
    console.error(`Config '${namespace}' not found.`);
    process.exit(1);
  }

  if (key) {
    if (!yes) {
      const ok = await confirm(`Delete '${namespace}.${key}' from config?`);
      if (!ok) { console.log('Cancelled.'); return; }
    }
    const raw = YAML.parse(readFileSync(file, 'utf8'));
    const config: Record<string, any> = (typeof raw === 'object' && raw !== null) ? raw : {};
    if (!(key in config)) {
      console.error(`Key '${key}' not found in '${namespace}'.`);
      process.exit(1);
    }
    delete config[key];
    if (Object.keys(config).length === 0) {
      rmSync(file);
      console.log(`Deleted '${namespace}' (config is now empty).`);
    } else {
      writeFileSync(file, YAML.stringify(config), 'utf8');
      console.log(`Deleted ${namespace}.${key}`);
    }
  } else {
    if (!yes) {
      const ok = await confirm(`Delete config '${namespace}' and all its values?`);
      if (!ok) { console.log('Cancelled.'); return; }
    }
    rmSync(file);
    console.log(`Deleted config '${namespace}'.`);
  }
}
