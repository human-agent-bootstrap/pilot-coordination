import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

export function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
  return {
    command,
    args,
    status: result.error ? -1 : result.status ?? -1,
    stdout: (result.stdout ?? '').replace(/\s+$/, ''),
    stderr: (result.stderr ?? result.error?.message ?? '').trim(),
  };
}

// The approved plan version is a commit reachable from the integration branch.
// Both bootstrap and the writer CLI gate on this before trusting a packet.
export function validatePlanSha(planSha, { cwd = process.cwd(), run = defaultRun } = {}) {
  if (!isFullSha(planSha)) throw new Error(`invalid --plan-sha: expected a full 40-character commit SHA, got ${planSha}`);
  if (run('git', ['cat-file', '-e', `${planSha}^{commit}`], { cwd }).status !== 0) {
    throw new Error(`plan SHA is not available locally: ${planSha}`);
  }
  const approvedRef = run('git', ['rev-parse', '--verify', 'origin/main'], { cwd }).status === 0 ? 'origin/main' : 'main';
  if (run('git', ['merge-base', '--is-ancestor', planSha, approvedRef], { cwd }).status !== 0) {
    throw new Error(`plan SHA ${planSha} is not reachable from ${approvedRef}`);
  }
  return approvedRef;
}

// A work unit declares its own checks; otherwise the service registry supplies them.
export function verifyCommandsFor(unit, services = []) {
  if (unit?.verify?.length) return { commands: unit.verify, source: 'work unit' };
  const service = services.find((entry) => entry.id === String(unit?.repo));
  if (service?.verify?.length) return { commands: service.verify, source: 'service registry' };
  return { commands: [], source: 'none declared' };
}

export function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

const BOOLEAN_FLAGS = new Set([
  'apply',
  'allow-failing-checks',
  'allow-descendant',
  'allow-uninitialized',
  'strict',
  'detect',
  'branch-from-git',
  'with-example',
]);

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) { options[key] = true; continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export function required(options, ...names) {
  for (const name of names) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
}

export function safeIdentifier(label, value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`invalid ${label}: use 1-128 letters, numbers, underscores, or hyphens`);
  }
  return value;
}

export function manifestPath(change) {
  return join(process.cwd(), 'changes', change, 'WORK_UNITS.yaml');
}

export function isFullSha(value) {
  return /^[0-9a-f]{40}$/i.test(String(value ?? ''));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function readYaml(path) {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  try {
    return YAML.parse(readFileSync(path, 'utf8')) ?? {};
  } catch (error) {
    throw new Error(`invalid YAML in ${path}: ${error.message}`);
  }
}

export function readAtRef(ref, path) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(`missing file at ${ref}: ${path}`);
  }
}

export function readYamlAtRef(ref, path) {
  try {
    return YAML.parse(readAtRef(ref, path)) ?? {};
  } catch (error) {
    if (error.message.startsWith('missing file at ')) throw error;
    throw new Error(`invalid YAML at ${ref}:${path}: ${error.message}`);
  }
}

export function registryPath() {
  return join(process.cwd(), 'services', 'registry.yaml');
}

// cross-repository remains readable for historical examples; new scaffolds do not emit it.
export const REPO_SENTINELS = new Set(['root', 'cross-repository']);

export function readRegistry(ref) {
  const registry = ref
    ? readYamlAtRef(ref, 'services/registry.yaml')
    : readYaml(registryPath());
  const services = registry.services ?? [];
  if (!Array.isArray(services)) throw new Error('registry services must be a list');
  for (const service of services) {
    if (!service?.id || !service?.path) throw new Error('every registry service needs id and path');
  }
  return {
    version: registry.version ?? 1,
    github: registry.github ?? {},
    services,
  };
}

export function readChangeManifest(change, ref) {
  const relativePath = `changes/${change}/WORK_UNITS.yaml`;
  const manifest = ref ? readYamlAtRef(ref, relativePath) : readYaml(manifestPath(change));
  const units = manifest.work_units ?? [];
  if (!Array.isArray(units)) throw new Error(`work_units must be a list in ${relativePath}`);
  for (const unit of units) {
    unit.write_paths ??= [];
    unit.depends_on ??= [];
    unit.verify ??= [];
  }
  return { ...manifest, work_units: units };
}

export function readWorkUnits(change, ref) {
  return readChangeManifest(change, ref).work_units;
}

// The planning unit merges through its own PR, so a manifest written before that
// merge can never record it as `merged`. Dependents may still become ready; the
// plan SHA gate (reachable from origin/main) proves the planning merge happened.
export function isPlanningUnit(changeId, unit) {
  return String(unit?.repo) === 'root' && unit?.branch === `change/${changeId}/coordination`;
}

export function findUnit(change, id, ref) {
  const unit = readWorkUnits(change, ref).find((item) => item.id === id);
  if (!unit) throw new Error(`unknown work unit: ${id}`);
  return unit;
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
