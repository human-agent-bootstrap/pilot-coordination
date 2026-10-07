import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  fail,
  isFullSha,
  parseArgs,
  readAtRef,
  readRegistry,
  readYaml,
  required,
} from './lib.mjs';

function candidateFile(value) {
  const candidate = String(value ?? '001');
  if (!/^\d{1,3}$/.test(candidate)) throw new Error(`invalid candidate: use 1-3 digits, got ${candidate}`);
  return `candidate-${candidate.padStart(3, '0')}.yaml`;
}


function headOf(path) {
  const directory = join(process.cwd(), path);
  if (!existsSync(join(directory, '.git'))) return null;
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function acceptanceCriteria(change, planSha) {
  const plan = readAtRef(planSha, `changes/${change}/PLAN.md`);
  return [...plan.matchAll(/^\s*-\s+\[(AC-\d+)\]\s+/gm)].map((match) => match[1]);
}

function targetGitlink(ref, path) {
  const row = git(['ls-tree', ref, '--', path]);
  const match = row.match(/^160000 commit ([0-9a-f]{40})\t/);
  if (!match) throw new Error(`${path} is not a submodule in target ref ${ref}`);
  return match[1];
}

function verifyEvidence(candidate, change, prsManifest) {
  if (!isFullSha(candidate.plan_sha)) throw new Error('candidate plan_sha must be a full commit SHA');
  if (!isFullSha(prsManifest.plan_merge_sha) || prsManifest.plan_merge_sha !== candidate.plan_sha) {
    throw new Error('candidate plan_sha must match PRS.yaml plan_merge_sha');
  }
  const planning = (prsManifest.prs ?? []).find((pr) => pr.key === 'root-planning');
  if (!planning || planning.state !== 'merged' || planning.merge_sha !== candidate.plan_sha) {
    throw new Error('candidate plan_sha must match the merged root-planning PR');
  }
  const criteria = acceptanceCriteria(change, candidate.plan_sha);
  if (criteria.length === 0) throw new Error(`no AC identifiers found in ${change}/PLAN.md at ${candidate.plan_sha}`);
  const evidence = candidate.evidence ?? [];
  for (const criterion of criteria) {
    const entries = evidence.filter((entry) => entry.criterion === criterion);
    if (entries.length === 0) throw new Error(`missing evidence for ${criterion}`);
    for (const entry of entries) {
      if (entry.kind === 'command') {
        if (!entry.command || !isFullSha(entry.target_sha) || Number(entry.exit_code) !== 0) {
          throw new Error(`${criterion}: command evidence needs command, full target_sha, and exit_code 0`);
        }
        const targets = new Set((candidate.services ?? []).map((service) => String(service.sha)));
        if (!targets.has(String(entry.target_sha))) {
          throw new Error(`${criterion}: target_sha is not part of this candidate`);
        }
      } else if (entry.kind === 'review') {
        if (!entry.reviewer || !entry.url) throw new Error(`${criterion}: review evidence needs reviewer and url`);
      } else {
        throw new Error(`${criterion}: evidence kind must be command or review`);
      }
    }
  }
}

function verifyIntegrationRange(service, prs, directory) {
  if (!isFullSha(service.base_sha)) throw new Error(`${service.repo}: base_sha must be a full commit SHA`);
  if (!isFullSha(service.sha)) throw new Error(`${service.repo}: sha must be a full commit SHA`);
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', service.base_sha, service.sha], {
    cwd: directory,
    stdio: 'ignore',
  });
  if (ancestry.status !== 0) throw new Error(`${service.repo}: candidate SHA is not a descendant of base_sha`);
  const keys = service.source_prs ?? [];
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`${service.repo}: source_prs must not be empty`);
  const expected = keys.map((key) => {
    const pr = prs.get(key);
    if (!pr) throw new Error(`${service.repo}: unknown source PR key ${key}`);
    if (pr.repo !== service.repo) throw new Error(`${service.repo}: source PR ${key} belongs to ${pr.repo}`);
    if (pr.state !== 'merged' || !isFullSha(pr.merge_sha)) throw new Error(`${service.repo}: source PR ${key} is not recorded as merged`);
    return pr.merge_sha;
  });
  const actual = git(['rev-list', '--first-parent', '--reverse', `${service.base_sha}..${service.sha}`], directory)
    .split('\n')
    .filter(Boolean);
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(`${service.repo}: integration range does not exactly match source_prs`);
  }
}

// Find the candidate whose pinned SHAs equal the checked-out submodule snapshot.
function detectActive() {
  const changesDirectory = join(process.cwd(), 'changes');
  const found = [];
  let candidatesExist = false;
  for (const entry of readdirSync(changesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const releases = join(changesDirectory, entry.name, 'releases');
    if (!existsSync(releases)) continue;
    for (const file of readdirSync(releases)) {
      const match = file.match(/^candidate-(\d{3})\.yaml$/);
      if (!match) continue;
      const services = readYaml(join(releases, file)).services ?? [];
      if (!services.length) continue;
      const matches = services.every((service) => service.path && headOf(service.path) === String(service.sha));
      candidatesExist = true;
      if (matches) found.push({ change: entry.name, candidate: match[1] });
    }
  }
  return { found, candidatesExist };
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.detect) {
    const { found: active, candidatesExist } = detectActive();
    if (!candidatesExist) {
      process.stdout.write('NOTE: no release candidate is declared yet; nothing to verify.\n');
      process.exit(0);
    }
    if (active.length === 0) {
      throw new Error('candidates exist but none matches the checked-out submodule snapshot; pin one or pass --change explicitly');
    }
    if (active.length > 1) {
      process.stdout.write(`NOTE: ${active.length} candidates match this snapshot; verifying ${active[0].change}/candidate-${active[0].candidate}.\n`);
    }
    options.change ??= active[0].change;
    options.candidate ??= active[0].candidate;
  }
  required(options, 'change');
  const path = join(process.cwd(), 'changes', options.change, 'releases', candidateFile(options.candidate));
  if (!existsSync(path)) throw new Error(`missing candidate: ${path}`);

  const candidate = readYaml(path);
  const services = candidate.services ?? [];
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error('candidate declares no services');
  }
  // A candidate pins any subset of the registry — one service or twenty.
  const registryFile = readRegistry();
  const strict = registryFile.version >= 2 || candidate.schema_version >= 1;
  if (strict && candidate.schema_version !== 1) throw new Error('candidate schema_version must be 1');
  const registry = new Map(registryFile.services.map((service) => [service.id, service]));
  const prsManifest = strict
    ? readYaml(join(process.cwd(), 'changes', options.change, 'PRS.yaml'))
    : {};
  if (strict && prsManifest.schema_version !== 1) throw new Error('PRS.yaml schema_version must be 1');
  if (strict) verifyEvidence(candidate, options.change, prsManifest);
  const prs = new Map((prsManifest.prs ?? []).map((pr) => [pr.key, pr]));
  const seen = new Set();

  for (const service of services) {
    const id = String(service?.repo ?? '');
    if (!id) throw new Error('every candidate service needs a repo id');
    if (seen.has(id)) throw new Error(`candidate lists ${id} more than once`);
    seen.add(id);

    const registered = registry.get(id);
    if (!registered) {
      throw new Error(`candidate service ${id} is not in services/registry.yaml (known: ${[...registry.keys()].join(', ')})`);
    }
    // A 40-digit SHA parses as a number, so test for absence rather than falsiness.
    const declared = (value) => value !== undefined && value !== null && String(value) !== '';
    if (!declared(service.path) || !declared(service.sha)) {
      throw new Error(`candidate service ${id} needs path and sha`);
    }
    if (service.path !== registered.path) {
      throw new Error(`candidate service ${id} must use path ${registered.path}, got ${service.path}`);
    }

    const directory = join(process.cwd(), service.path);
    if (!existsSync(join(directory, '.git'))) throw new Error(`submodule is not initialized: ${service.path}`);
    const actual = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (actual !== String(service.sha)) {
      throw new Error(`${id} SHA mismatch: expected ${service.sha}, found ${actual}`);
    }
    if (strict) {
      if (options['target-ref']) {
        const target = targetGitlink(options['target-ref'], service.path);
        if (target !== String(service.base_sha)) {
          throw new Error(`${id} stale base: candidate starts at ${service.base_sha}, ${options['target-ref']} points to ${target}`);
        }
      }
      verifyIntegrationRange(service, prs, directory);
      if (options['target-ref']) {
        const reachable = git(['branch', '-r', '--contains', String(service.sha)], directory);
        if (!reachable) throw new Error(`${id}: ${service.sha} is not reachable from a remote branch`);
      }
    }
  }

  const summary = services.map((service) => `${service.repo}@${String(service.sha).slice(0, 12)}`).join(', ');
  process.stdout.write(`Candidate ${options.change}: PASS (${services.length} service(s): ${summary})\n`);
} catch (error) {
  fail(error.message);
}
