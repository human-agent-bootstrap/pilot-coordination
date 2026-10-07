import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  fail,
  isPlanningUnit,
  parseArgs,
  readAtRef,
  readChangeManifest,
  readRegistry,
  required,
  safeIdentifier,
  sha256,
  validatePlanSha,
  verifyCommandsFor,
  writeText,
} from './lib.mjs';

function git(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function contractSnapshots(changeId, planSha) {
  const prefix = `changes/${changeId}/contracts/`;
  if (!planSha) {
    const directory = join(process.cwd(), prefix);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => !name.startsWith('.'))
      .sort()
      .map((name) => {
        const path = `${prefix}${name}`;
        return { path, digest: sha256(readFileSync(join(process.cwd(), path), 'utf8')) };
      });
  }
  const paths = git(['ls-tree', '-r', '--name-only', planSha, '--', prefix])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  return paths.map((path) => ({ path, digest: sha256(readAtRef(planSha, path)) }));
}

function verifyCommands(unit, planSha) {
  let services = [];
  try {
    services = readRegistry(planSha).services;
  } catch {
    // A missing or invalid registry is reported by verify-registry.mjs, not here.
  }
  return verifyCommandsFor(unit, services);
}

try {
  const options = parseArgs(process.argv.slice(2));
  required(options, 'change', 'unit', 'writer', 'run');
  const changeId = safeIdentifier('change ID', options.change);
  const unitId = safeIdentifier('work unit ID', options.unit);
  const writer = safeIdentifier('writer', options.writer);
  const runId = safeIdentifier('run ID', options.run);
  const planSha = options['plan-sha'];
  if (planSha) validatePlanSha(planSha);
  const manifest = readChangeManifest(changeId, planSha);
  const strict = readRegistry(planSha).version >= 2 || manifest.schema_version >= 1;
  if (strict && manifest.schema_version !== 1) throw new Error('WORK_UNITS.yaml schema_version must be 1');
  const unit = manifest.work_units.find((item) => item.id === unitId);
  if (!unit) throw new Error(`unknown work unit: ${unitId}`);
  if (strict && unit.repo !== 'root') {
    if (!planSha) throw new Error('--plan-sha is required for implementation work units');
    if (!['approved', 'active'].includes(String(manifest.state))) {
      throw new Error(`change ${changeId} must be approved or active before dispatch`);
    }
    if (!['ready', 'in_progress'].includes(String(unit.state))) {
      throw new Error(`work unit ${unitId} must be ready or in_progress before dispatch`);
    }
    if (unit.writer !== writer) {
      throw new Error(`writer mismatch: expected ${unit.writer}, got ${writer}`);
    }
    for (const dependencyId of unit.depends_on) {
      const dependency = manifest.work_units.find((item) => item.id === dependencyId);
      if (!dependency) throw new Error(`unknown dependency: ${dependencyId}`);
      if (!isPlanningUnit(changeId, dependency) && dependency.state !== 'merged') {
        throw new Error(`dependency ${dependencyId} must be merged before dispatch`);
      }
    }
  }
  const packetDirectory = resolve(process.cwd(), '.task-packets');
  const packetPath = resolve(packetDirectory, `${runId}.md`);
  if (dirname(packetPath) !== packetDirectory) throw new Error('invalid run ID: task packet path escapes .task-packets');
  if (existsSync(packetPath)) throw new Error(`task packet already exists: ${packetPath}`);

  const contracts = contractSnapshots(changeId, planSha);
  const { commands, source } = verifyCommands(unit, planSha);
  const manifestDigest = planSha
    ? sha256(readAtRef(planSha, `changes/${changeId}/WORK_UNITS.yaml`))
    : 'working-tree';

  const packetBody = [
    '# TASK',
    `- Change ID: ${changeId}`,
    `- Work Unit ID: ${unit.id}`,
    `- Writer: ${writer}`,
    `- Run ID: ${runId}`,
    `- Plan SHA: ${planSha ?? 'working-tree'}`,
    `- Manifest SHA-256: ${manifestDigest}`,
    `- Goal: ${unit.goal}`,
    '',
    '# SCOPE',
    `- Repository: ${unit.repo}`,
    `- Required branch: ${unit.branch}`,
    `- Base SHA: ${unit.base_sha}`,
    '- Allowed paths:',
    ...unit.write_paths.map((path) => `  - ${path}`),
    '',
    '# CONTRACT',
    '- Read AGENTS.md and WRITER.md in the Root repository before implementation.',
    ...(contracts.length
      ? ['- Approved contract snapshots (do not modify):', ...contracts.map(({ path, digest }) => `  - ${path} (sha256:${digest})`)]
      : ['- This change declares no contract snapshot. Stop and ask before assuming any cross-service interface.']),
    '- Do not modify the Root coordination files or another repository.',
    '',
    `# VERIFY (${source})`,
    ...(commands.length
      ? commands.map((command) => `- ${command} (expect exit 0)`)
      : ['- No verification is declared. Stop and ask the Coordinator; do not invent commands.']),
    '',
    '# HANDOFF',
    'Report changed files, head SHA, commands and exit codes, unrun checks, and next action.',
    '',
    '# STOP WHEN',
    'Scope expansion, contract conflict, secret/production access, or an unavailable required check needs human coordination.',
    '',
  ].join('\n');
  const packetDigest = sha256(packetBody);
  const packet = `${packetBody}Packet SHA-256: ${packetDigest}\n`;

  if (!options.apply) {
    process.stdout.write(`DRY RUN: task packet would be written to ${packetPath}\n`);
    process.stdout.write(`Plan SHA: ${planSha ?? 'working-tree'}\n`);
    process.stdout.write(`Packet SHA-256: ${packetDigest}\n`);
    process.stdout.write(`Contracts: ${contracts.length ? contracts.map(({ path }) => path).join(', ') : 'none'}\n`);
    process.stdout.write(`Verify commands (${source}): ${commands.length}\n`);
    process.stdout.write(`This command does not create a branch or workspace. Required branch: ${unit.branch}\n`);
  } else {
    writeText(packetPath, packet);
    process.stdout.write(`APPLIED: wrote ${packetPath}\n`);
    process.stdout.write('Branch and workspace setup are handled by the user or agent harness.\n');
  }
} catch (error) {
  fail(error.message);
}
