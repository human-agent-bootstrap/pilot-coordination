import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import { fail, isFullSha, parseArgs, readRegistry, required, safeIdentifier, writeText } from './lib.mjs';

const TEMPLATE = '_TEMPLATE';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// A fresh coordinator repo may have no commits yet. Service bases are stricter:
// selected services must already have an anchor commit before planning starts.
function revParse(directory, missing = 'pending-submodule-not-initialized') {
  if (!existsSync(join(directory, '.git'))) return missing;
  try {
    return git(['rev-parse', 'HEAD'], directory);
  } catch {
    return missing;
  }
}

function templateFiles(root) {
  const found = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) found.push(...templateFiles(path));
    else found.push(path);
  }
  return found;
}

function selectedServices(value) {
  if (!value) return [];
  const ids = value.split(',').map((id) => safeIdentifier('service id', id.trim())).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('--services contains duplicate ids');
  const registry = readRegistry();
  return ids.map((id) => {
    const service = registry.services.find((entry) => entry.id === id);
    if (!service) throw new Error(`unknown service: ${id}`);
    const localSha = revParse(join(process.cwd(), service.path));
    let baseSha = localSha;
    if (registry.version >= 2) {
      let row = '';
      try {
        row = git(['ls-tree', 'HEAD', '--', service.path], process.cwd());
      } catch {
        // Report a targeted message below.
      }
      const match = row.match(/^160000 commit ([0-9a-f]{40})\t/);
      if (!match) {
        throw new Error(`service ${id} is not committed as a Root submodule; commit service registration before change:create`);
      }
      baseSha = match[1];
      if (localSha !== baseSha) {
        throw new Error(`service ${id} checkout ${localSha} does not match Root gitlink ${baseSha}`);
      }
    }
    if (!isFullSha(baseSha)) {
      throw new Error(`service ${id} has no local base commit; initialize its submodule and create the repository anchor commit before change:create`);
    }
    return { ...service, base_sha: baseSha };
  });
}

function yaml(value) {
  return YAML.stringify(value, { lineWidth: 0 });
}

try {
  const options = parseArgs(process.argv.slice(2));
  required(options, 'change');
  const changeId = safeIdentifier('change ID', options.change);
  if (changeId === TEMPLATE) throw new Error(`refusing to overwrite the ${TEMPLATE} skeleton`);

  const changesDirectory = resolve(process.cwd(), 'changes');
  const templateDirectory = join(changesDirectory, TEMPLATE);
  if (!existsSync(templateDirectory)) throw new Error(`missing template: ${templateDirectory}`);

  const targetDirectory = resolve(changesDirectory, changeId);
  if (relative(changesDirectory, targetDirectory).startsWith('..')) {
    throw new Error('invalid change ID: target escapes changes/');
  }
  if (existsSync(targetDirectory)) throw new Error(`change already exists: changes/${changeId}`);

  const substitutions = new Map([
    ['<CHANGE-ID>', changeId],
    ['<ROOT_BASE_SHA>', revParse(process.cwd(), 'pending-no-root-commit')],
  ]);
  const services = selectedServices(options.services);

  const planned = templateFiles(templateDirectory).map((source) => {
    let text = readFileSync(source, 'utf8');
    for (const [token, value] of substitutions) text = text.split(token).join(value);
    const relativePath = relative(templateDirectory, source);
    return { relativePath, target: join(targetDirectory, relativePath), text };
  });
  const rootBase = substitutions.get('<ROOT_BASE_SHA>');
  const serviceUnits = services.map((service) => {
    const id = `${service.id}-implementation`;
    return {
      id,
      repo: service.id,
      state: 'draft',
      goal: `<implement ${service.id} slice>`,
      branch: `feat/${changeId}/${id}`,
      base_sha: service.base_sha,
      writer: 'unassigned',
      write_paths: [],
      depends_on: ['contract-and-plan'],
      verify: service.verify ?? [],
    };
  });
  const generated = new Map([
    ['WORK_UNITS.yaml', yaml({
      schema_version: 1,
      change_id: changeId,
      state: 'draft',
      plan_base_sha: rootBase,
      plan_merge_sha: 'pending',
      work_units: [
        {
          id: 'contract-and-plan',
          repo: 'root',
          state: 'draft',
          goal: 'Approve the scope, contracts, work boundaries, and verification gates.',
          branch: `change/${changeId}/coordination`,
          base_sha: rootBase,
          writer: 'coordinator',
          write_paths: [`changes/${changeId}/**`],
          depends_on: [],
          verify: [
            'npm test',
            `npm run verify:registry -- --change ${changeId} --strict`,
          ],
        },
        ...serviceUnits,
        {
          id: 'candidate-integration',
          repo: 'root',
          state: 'draft',
          goal: 'Pin reviewed service merge SHAs and verify the exact candidate.',
          branch: `change/${changeId}/candidate-integration`,
          base_sha: 'pending-plan-merge',
          writer: 'coordinator',
          // The candidate PR fills its own base_sha and records merged units in
          // WORK_UNITS.yaml, and owns the root-level E2E suite it must satisfy.
          write_paths: [
            `changes/${changeId}/WORK_UNITS.yaml`,
            `changes/${changeId}/PRS.yaml`,
            `changes/${changeId}/STATUS.md`,
            `changes/${changeId}/releases/**`,
            'e2e/**',
            ...services.map((service) => service.path),
          ],
          depends_on: serviceUnits.map((unit) => unit.id),
          verify: [
            'npm test',
            `npm run verify:prs -- --change ${changeId}`,
            `npm run verify:candidate -- --change ${changeId} --target-ref origin/main`,
          ],
        },
      ],
    })],
    ['PRS.yaml', yaml({
      schema_version: 1,
      change_id: changeId,
      state: 'draft',
      plan_merge_sha: 'pending',
      prs: [
        {
          key: 'root-planning',
          repo: 'root',
          work_unit: 'contract-and-plan',
          number: null,
          state: 'not-started',
          base_sha: rootBase,
          head_sha: null,
          merge_sha: null,
        },
        ...services.map((service) => ({
          key: `${service.id}-implementation`,
          repo: service.id,
          work_unit: `${service.id}-implementation`,
          number: null,
          state: 'not-started',
          base_sha: service.base_sha,
          head_sha: null,
          merge_sha: null,
          merge_method: 'squash',
        })),
        {
          key: 'root-candidate',
          repo: 'root',
          work_unit: 'candidate-integration',
          number: null,
          state: 'not-started',
          base_sha: 'pending-plan-merge',
          head_sha: null,
          merge_sha: null,
        },
      ],
    })],
    ['releases/candidate-001.yaml', yaml({
      schema_version: 1,
      change_id: changeId,
      candidate: 1,
      state: 'draft',
      plan_sha: 'pending-planning-merge',
      services: services.map((service) => ({
        repo: service.id,
        path: service.path,
        base_sha: service.base_sha,
        sha: 'pending-human-approved-merge',
        source_prs: [`${service.id}-implementation`],
      })),
      evidence: [],
    })],
  ]);
  for (const file of planned) {
    const replacement = generated.get(file.relativePath);
    if (replacement) file.text = replacement;
  }

  for (const [token, value] of substitutions) {
    process.stdout.write(`${token} -> ${value}\n`);
  }
  process.stdout.write(`Services -> ${services.length ? services.map((service) => service.id).join(', ') : '(root-only)'}\n`);

  if (!options.apply) {
    process.stdout.write(`DRY RUN: would create changes/${changeId} with ${planned.length} file(s):\n`);
    for (const file of planned) process.stdout.write(`  ${relative(process.cwd(), file.target)}\n`);
    process.stdout.write('No file is created without --apply. Branch and workspace setup are always external.\n');
  } else {
    for (const file of planned) writeText(file.target, file.text);
    process.stdout.write(`APPLIED: wrote ${planned.length} file(s) under changes/${changeId}\n`);
    process.stdout.write(`Next: fill the placeholders, then open a planning PR on change/${changeId}/coordination.\n`);
    process.stdout.write('Remaining <...> placeholders are intentional and must be resolved by a human before approval.\n');
  }
} catch (error) {
  fail(error.message);
}
