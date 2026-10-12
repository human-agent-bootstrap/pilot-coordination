import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isFullSha, parseArgs, readYaml, required } from './lib.mjs';
import { createGithub, githubSlug } from './github.mjs';

function rootSlug(cwd, host) {
  return githubSlug(execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd,
    encoding: 'utf8',
  }).trim(), host);
}

export async function verifyPrs({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = fetch,
  run,
} = {}) {
  const options = parseArgs(argv);
  required(options, 'change');
  const registryFile = readYaml(join(cwd, 'services/registry.yaml'));
  const githubHost = registryFile.github?.host ?? 'github.com';
  const configuredApiBase = registryFile.github?.api_base
    ?? (githubHost === 'github.com' ? 'https://api.github.com' : `https://${githubHost}/api/v3`);
  const api = createGithub({
    cwd, env, fetchImpl, run,
    registry: { ...registryFile, github: { ...registryFile.github, api_base: options['api-base'] ?? configuredApiBase } },
  });
  const registry = new Map((registryFile.services ?? []).map((service) => [service.id, service]));
  const manifest = readYaml(join(cwd, 'changes', options.change, 'PRS.yaml'));
  const rows = manifest.prs ?? [];
  if (!Array.isArray(rows)) throw new Error('PRS.yaml prs must be a list');
  const strict = registryFile.version >= 2 || manifest.schema_version >= 1;
  if (strict && manifest.schema_version !== 1) throw new Error('PRS.yaml schema_version must be 1');
  if (strict && rows.length === 0) throw new Error('PRS.yaml must declare at least one PR');

  let checked = 0;
  for (const row of rows) {
    const pendingCandidate = row.key === 'root-candidate' && row.state !== 'merged';
    if (pendingCandidate) continue;
    if (row.state !== 'merged' || !Number.isInteger(row.number) || row.number <= 0) {
      if (strict) throw new Error(`${row.key}: expected state merged and a positive PR number`);
      continue;
    }
    const slug = row.repo === 'root'
      ? rootSlug(cwd, githubHost)
      : githubSlug(registry.get(row.repo)?.repo, githubHost);
    const pull = await api.get(`/repos/${slug}/pulls/${row.number}`);
    if (!pull.merged_at) throw new Error(`${row.key}: PR #${row.number} is not merged`);
    const author = pull.user?.login;
    if (!author) throw new Error(`${row.key}: GitHub PR author is missing`);
    const expected = [
      ['base_sha', pull.base?.sha],
      ['head_sha', pull.head?.sha],
      ['merge_sha', pull.merge_commit_sha],
    ];
    for (const [field, actual] of expected) {
      if (!isFullSha(row[field]) || row[field] !== actual) {
        throw new Error(`${row.key}: ${field} ${row[field]} does not match GitHub ${actual}`);
      }
    }
    checked += 1;
  }
  if (strict && checked === 0) throw new Error('no merged PR was verified');

  return `PR verification PASS: ${options.change}; ${checked} merged PR(s) checked.\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.stdout.write(await verifyPrs());
  } catch (error) {
    fail(error.message);
  }
}
