import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, parseArgs, required } from './lib.mjs';

const PLACEHOLDER_FILES = [
  'README.md',
  'package.json',
  'services/registry.yaml',
];

function substitutionTargets() {
  return PLACEHOLDER_FILES.filter((file) => existsSync(join(process.cwd(), file)));
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options['with-example']) {
    throw new Error('--with-example is no longer supported: the template ships without examples/');
  }
  required(options, 'name', 'org');
  const name = options.name;
  const org = options.org;
  const githubHost = options['github-host'] ?? 'github.com';
  const githubApiBase = options['github-api-base']
    ?? (githubHost === 'github.com' ? 'https://api.github.com' : `https://${githubHost}/api/v3`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new Error(`invalid --name: ${name}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(org)) throw new Error(`invalid --org: ${org}`);
  if (!/^[A-Za-z0-9.-]+$/.test(githubHost)) throw new Error(`invalid --github-host: ${githubHost}`);
  try {
    new URL(githubApiBase);
  } catch {
    throw new Error(`invalid --github-api-base: ${githubApiBase}`);
  }

  const targets = substitutionTargets();
  const pending = targets.filter((file) => /<PROJECT-NAME>|<ORG>|<GITHUB-HOST>|<GITHUB-API-BASE>/.test(readFileSync(join(process.cwd(), file), 'utf8')));
  if (pending.length === 0) {
    throw new Error('this repository is already initialized: no <PROJECT-NAME> or <ORG> placeholder remains');
  }

  process.stdout.write(`<PROJECT-NAME> -> ${name}\n<ORG> -> ${org}\n`);
  process.stdout.write(`<GITHUB-HOST> -> ${githubHost}\n<GITHUB-API-BASE> -> ${githubApiBase}\n`);
  process.stdout.write(`Files to rewrite: ${pending.join(', ')}\n`);

  if (!options.apply) {
    process.stdout.write("DRY RUN: would clear this template's own change records under changes/, keeping _TEMPLATE\n");
    process.stdout.write('Nothing is written without --apply.\n');
  } else {
    for (const file of pending) {
      const path = join(process.cwd(), file);
      writeFileSync(path, readFileSync(path, 'utf8')
        .split('<PROJECT-NAME>').join(name)
        .split('<ORG>').join(org)
        .split('<GITHUB-HOST>').join(githubHost)
        .split('<GITHUB-API-BASE>').join(githubApiBase));
    }
    // A new project must not inherit this template's own change history.
    const changesDir = join(process.cwd(), 'changes');
    if (existsSync(changesDir)) {
      for (const entry of readdirSync(changesDir)) {
        if (entry !== '_TEMPLATE') rmSync(join(changesDir, entry), { recursive: true, force: true });
      }
    }
    process.stdout.write(`APPLIED: initialized ${name}\n`);
    process.stdout.write('Next: npm run service:add -- --repo <https-url> --apply, then npm run change:create.\n');
  }
} catch (error) {
  fail(error.message);
}
