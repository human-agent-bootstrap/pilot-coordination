import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, parseArgs, readRegistry, registryPath, required, safeIdentifier } from './lib.mjs';

try {
  const options = parseArgs(process.argv.slice(2));
  required(options, 'repo');
  const url = options.repo;
  const registry = readRegistry();
  const githubHost = registry.github.host;
  let parsed;
  if (!url.startsWith('file://')) {
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid --repo URL: ${url}`);
    }
    if (parsed.protocol !== 'https:' || (githubHost && parsed.hostname !== githubHost)) {
      throw new Error(`service repositories must use HTTPS on ${githubHost || 'the configured GitHub host'}`);
    }
    if (parsed.pathname.split('/').filter(Boolean).length !== 2) {
      throw new Error(`invalid GitHub repository URL: ${url}`);
    }
  }
  const repositoryName = url.startsWith('file://')
    ? new URL(url).pathname.split('/').filter(Boolean).at(-1)
    : parsed.pathname.split('/').filter(Boolean).at(-1);
  const id = safeIdentifier('service id', options.id ?? repositoryName.replace(/\.git$/i, ''));
  const path = options.path ?? `services/${id}`;
  if (!path.startsWith('services/')) throw new Error(`invalid --path: must live under services/, got ${path}`);

  const existing = registry.services;
  if (existing.some((service) => service.id === id)) throw new Error(`service ${id} is already registered`);
  if (existing.some((service) => service.path === path)) throw new Error(`path ${path} is already registered`);
  if (existsSync(join(process.cwd(), path))) throw new Error(`${path} already exists on disk`);

  const stack = options.stack ?? 'unspecified';
  if (!/^[A-Za-z0-9][A-Za-z0-9+_.-]{0,63}$/.test(stack)) throw new Error('invalid --stack value');
  const inferredOwner = parsed ? `@${parsed.pathname.split('/').filter(Boolean)[0]}` : '';
  const owners = (options.owners ?? inferredOwner).split(',').map((owner) => owner.trim()).filter(Boolean);
  const verify = (options.verify ?? '').split(',').map((command) => command.trim()).filter(Boolean);

  const entry = [
    '',
    `  - id: ${id}`,
    `    path: ${path}`,
    `    repo: ${url}`,
    `    stack: ${stack}`,
    ...(owners.length ? ['    owners:', ...owners.map((owner) => `      - "${owner}"`)] : []),
    ...(verify.length ? ['    verify:', ...verify.map((command) => `      - ${command}`)] : ['    verify: []']),
    '',
  ].join('\n');

  if (!options.apply) {
    process.stdout.write(`DRY RUN: would add submodule ${path} -> ${url}\n`);
    process.stdout.write(`DRY RUN: would append to services/registry.yaml:\n${entry}`);
    if (!verify.length) process.stdout.write('NOTE: no --verify given; each active work unit must declare its own commands.\n');
    process.stdout.write('Nothing is written without --apply.\n');
  } else {
    const added = spawnSync('git', ['submodule', 'add', url, path], { encoding: 'utf8', stdio: 'inherit' });
    if (added.status !== 0) throw new Error(`git submodule add failed for ${url}`);

    // An empty registry serializes as `services: []`; turn it into a block before appending.
    const file = registryPath();
    const text = readFileSync(file, 'utf8');
    const emptyList = /^services:[ \t]*\[\][ \t]*\r?\n?/m;
    if (emptyList.test(text)) {
      writeFileSync(file, `${text.replace(emptyList, 'services:\n')}${entry.replace(/^\n/, '')}`);
    } else {
      appendFileSync(file, text.endsWith('\n') ? entry.replace(/^\n/, '') : entry);
    }

    process.stdout.write(`APPLIED: registered ${id} at ${path}\n`);
    const check = spawnSync(process.execPath, [join(import.meta.dirname, 'verify-registry.mjs')], { encoding: 'utf8', stdio: 'inherit' });
    if (check.status !== 0) throw new Error('registry validation failed after adding the service');
    process.stdout.write(`Next: record ${id} and its Writer in a change's work units.\n`);
  }
} catch (error) {
  fail(error.message);
}
