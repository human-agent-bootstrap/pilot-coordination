import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, isFullSha, isPlanningUnit, parseArgs, readChangeManifest, readRegistry, REPO_SENTINELS } from './lib.mjs';

const TERMINAL_UNIT_STATES = new Set(['merged', 'complete', 'completed', 'aborted', 'abandoned']);
const UNIT_STATES = new Set(['draft', 'ready', 'in_progress', 'merged', 'blocked', 'aborted']);
const CHANGE_STATES = new Set(['draft', 'approved', 'active', 'candidate', 'aborted']);

function gitmodules() {
  const path = join(process.cwd(), '.gitmodules');
  if (!existsSync(path)) return [];
  const entries = [];
  let current;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[submodule')) { current = {}; entries.push(current); continue; }
    if (!current) continue;
    const match = line.match(/^(path|url)\s*=\s*(.+)$/);
    if (match) current[match[1]] = match[2].trim();
  }
  return entries.filter((entry) => entry.path);
}

function changeIds() {
  const directory = join(process.cwd(), 'changes');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

// `app/**` covers `app/`; an exact path covers only itself.
function normalize(pattern) {
  return String(pattern).replace(/\/\*\*$/, '/').replace(/\*\*$/, '');
}

function overlaps(a, b) {
  if (String(a) === '**' || String(b) === '**') return true;
  const left = normalize(a);
  const right = normalize(b);
  if (left === right) return true;
  if (left.endsWith('/') && right.startsWith(left)) return true;
  if (right.endsWith('/') && left.startsWith(right)) return true;
  return false;
}

// Units connected by depends_on run in sequence, so sharing a path is safe.
function orderedPairs(units) {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const reachable = new Map();
  const walk = (id, seen = new Set()) => {
    if (reachable.has(id)) return reachable.get(id);
    const out = new Set();
    for (const dependency of byId.get(id)?.depends_on ?? []) {
      if (seen.has(dependency)) continue;
      out.add(dependency);
      for (const nested of walk(dependency, new Set([...seen, dependency]))) out.add(nested);
    }
    reachable.set(id, out);
    return out;
  };
  for (const unit of units) walk(unit.id);
  return (a, b) => reachable.get(a.id)?.has(b.id) || reachable.get(b.id)?.has(a.id);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const problems = [];
  const warnings = [];

  const registry = readRegistry();
  const byId = new Map(registry.services.map((service) => [service.id, service]));
  if (byId.size !== registry.services.length) problems.push('registry has duplicate service ids');
  if (registry.version >= 2) {
    for (const service of registry.services) {
      if (!Array.isArray(service.owners) || service.owners.length === 0) {
        problems.push(`service ${service.id}: owners must contain at least one GitHub user or team`);
      }
      if (service.verify !== undefined && !Array.isArray(service.verify)) problems.push(`service ${service.id}: verify must be a list`);
    }
  }

  const submodules = gitmodules();
  const byPath = new Map(submodules.map((entry) => [entry.path, entry]));

  for (const service of registry.services) {
    const submodule = byPath.get(service.path);
    if (!submodule) {
      problems.push(`service ${service.id}: path ${service.path} has no entry in .gitmodules`);
    } else if (service.repo && submodule.url && service.repo !== submodule.url) {
      problems.push(`service ${service.id}: registry url ${service.repo} != .gitmodules url ${submodule.url}`);
    }
    if (!options['allow-uninitialized']) {
      const directory = join(process.cwd(), service.path);
      if (!existsSync(directory)) problems.push(`service ${service.id}: ${service.path} does not exist`);
      else if (!existsSync(join(directory, '.git'))) problems.push(`service ${service.id}: ${service.path} is not an initialized submodule`);
    }
  }

  for (const submodule of submodules) {
    if (!registry.services.some((service) => service.path === submodule.path)) {
      problems.push(`submodule ${submodule.path} is not registered in services/registry.yaml`);
    }
  }

  const allChanges = changeIds();
  const targets = options.change ? [options.change] : allChanges;
  if (options.change && !allChanges.includes(options.change)) problems.push(`unknown change: ${options.change}`);
  const manifests = [];
  for (const change of allChanges) {
    let manifest;
    try {
      manifest = readChangeManifest(change);
    } catch (error) {
      problems.push(`${change}: ${error.message}`);
      continue;
    }
    const units = manifest.work_units;
    manifests.push({ change, manifest, units });
    if (!targets.includes(change)) continue;

    const strictManifest = registry.version >= 2 || manifest.schema_version >= 1;
    if (strictManifest && manifest.schema_version !== 1) {
      problems.push(`${change}: WORK_UNITS.yaml schema_version must be 1`);
    }
    if (strictManifest && !CHANGE_STATES.has(String(manifest.state ?? ''))) {
      problems.push(`${change}: invalid state "${manifest.state ?? ''}"`);
    }
    const unitIds = new Set();
    const branches = new Set();

    for (const unit of units) {
      if (!unit.id) problems.push(`${change}: work unit missing id`);
      else if (unitIds.has(unit.id)) problems.push(`${change}: duplicate work unit id ${unit.id}`);
      else unitIds.add(unit.id);
      const repo = String(unit.repo ?? '');
      if (!repo) problems.push(`${change}/${unit.id}: missing repo`);
      else if (!REPO_SENTINELS.has(repo) && !byId.has(repo)) {
        problems.push(`${change}/${unit.id}: repo "${repo}" is not a registry id or ${[...REPO_SENTINELS].join('/')}`);
      }
      if (unit.branch && unit.branch !== 'none') {
        if (branches.has(unit.branch)) problems.push(`${change}: duplicate branch ${unit.branch}`);
        branches.add(unit.branch);
      }
      if (strictManifest) {
        const state = String(unit.state ?? '');
        if (!UNIT_STATES.has(state)) problems.push(`${change}/${unit.id}: invalid state "${state}"`);
        for (const dependency of unit.depends_on) {
          const dependencyUnit = units.find((candidate) => candidate.id === dependency);
          if (!dependencyUnit) {
            problems.push(`${change}/${unit.id}: unknown dependency ${dependency}`);
          } else if (['ready', 'in_progress'].includes(state) && dependencyUnit.state !== 'merged'
            && !isPlanningUnit(change, dependencyUnit)) {
            problems.push(`${change}/${unit.id}: dependency ${dependency} must be merged before ${state}`);
          }
        }
        if (state !== 'draft') {
          if (!unit.writer || unit.writer === 'unassigned') problems.push(`${change}/${unit.id}: writer must be assigned before ${state}`);
          if (!isFullSha(unit.base_sha)) problems.push(`${change}/${unit.id}: base_sha must be a full commit SHA before ${state}`);
          if (unit.repo !== 'cross-repository' && unit.write_paths.length === 0) {
            problems.push(`${change}/${unit.id}: write_paths must not be empty before ${state}`);
          }
          const serviceVerify = byId.get(repo)?.verify ?? [];
          if (unit.repo !== 'cross-repository' && unit.verify.length === 0 && serviceVerify.length === 0) {
            problems.push(`${change}/${unit.id}: no verification commands declared`);
          }
        }
      }
    }

    if (strictManifest) {
      const visiting = new Set();
      const visited = new Set();
      const visit = (id) => {
        if (visiting.has(id)) {
          problems.push(`${change}: dependency cycle includes ${id}`);
          return;
        }
        if (visited.has(id)) return;
        visiting.add(id);
        const unit = units.find((candidate) => candidate.id === id);
        for (const dependency of unit?.depends_on ?? []) visit(dependency);
        visiting.delete(id);
        visited.add(id);
      };
      for (const unit of units) visit(unit.id);
    }
  }

  const draftChanges = manifests
    .filter(({ manifest }) => String(manifest.state ?? '').toLowerCase() === 'draft')
    .map(({ change }) => change);
  if (draftChanges.length > 1) {
    problems.push(`only one draft Change is allowed: ${draftChanges.join(', ')}`);
  }

  const active = manifests.flatMap(({ change, units }) => {
    const ordered = orderedPairs(units);
    return units
      .filter((unit) => !TERMINAL_UNIT_STATES.has(String(unit.state ?? '').toLowerCase()))
      .map((unit) => ({ change, unit, ordered }));
  });
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      if (String(a.unit.repo) !== String(b.unit.repo)) continue;
      if (a.change !== b.change && REPO_SENTINELS.has(String(a.unit.repo))) continue;
      if (a.change === b.change && a.ordered(a.unit, b.unit)) continue;
      const shared = a.unit.write_paths.filter((path) => b.unit.write_paths.some((other) => overlaps(path, other)));
      if (shared.length) {
        const left = a.change === b.change ? a.unit.id : `${a.change}/${a.unit.id}`;
        const right = a.change === b.change ? b.unit.id : `${b.change}/${b.unit.id}`;
        warnings.push(`concurrent units ${left} and ${right} both write ${shared.join(', ')} in repo ${a.unit.repo}`);
      }
    }
  }

  if (registry.services.length === 0) {
    process.stdout.write('NOTE: no services registered yet. Add one with: npm run service:add -- --repo <https-url> --apply\n');
  }

  for (const warning of warnings) process.stdout.write(`WARNING: ${warning}\n`);
  if (options.strict && warnings.length) problems.push(`${warnings.length} write-path overlap(s) between concurrent work units`);
  if (problems.length) throw new Error(problems.join('\n       '));

  process.stdout.write(`Registry PASS: ${registry.services.length} service(s) [${[...byId.keys()].join(', ')}]; ${targets.length} change(s) validated; ${warnings.length} warning(s).\n`);
} catch (error) {
  fail(error.message);
}
