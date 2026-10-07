import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultRun, sha256 } from '../scripts/lib.mjs';
import { createWriter } from '../scripts/writer/core.mjs';

const CHANGE = 'CHG-WRITER-001';
const UNIT = 'api-implementation';
const RUN = 'run-writer-001';
const BOOTSTRAP = new URL('../scripts/bootstrap.mjs', import.meta.url).pathname;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(path) {
  git(['init', '-qb', 'main'], path);
  git(['config', 'user.email', 'test@example.invalid'], path);
  git(['config', 'user.name', 'Test'], path);
  git(['config', 'advice.addEmbeddedRepo', 'false'], path);
}

function fixture({ verify = ['node -e "process.exit(0)"'] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'writer-cli-'));
  const serviceOrigin = join(base, 'api.git');
  const root = join(base, 'root');
  execFileSync('git', ['init', '-qb', 'main', '--bare', serviceOrigin]);

  const service = join(root, 'services/api');
  mkdirSync(join(service, 'src'), { recursive: true });
  initRepo(service);
  writeFileSync(join(service, 'README.md'), 'api\n');
  writeFileSync(join(service, 'src/index.js'), 'export const value = 1;\n');
  git(['add', '.'], service);
  git(['commit', '-qm', 'service base'], service);
  git(['remote', 'add', 'origin', serviceOrigin], service);
  git(['push', '-q', '-u', 'origin', 'main'], service);
  const baseSha = git(['rev-parse', 'HEAD'], service);

  mkdirSync(join(root, `changes/${CHANGE}/contracts`), { recursive: true });
  writeFileSync(join(root, 'services/registry.yaml'), `version: 2
github:
  host: github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: []
`);
  writeFileSync(join(root, `changes/${CHANGE}/contracts/api.md`), '# API\n');
  writeFileSync(join(root, `changes/${CHANGE}/WORK_UNITS.yaml`), `schema_version: 1
change_id: ${CHANGE}
state: approved
work_units:
  - id: ${UNIT}
    repo: api
    state: ready
    goal: 값을 하나 더 노출한다.
    branch: feat/${CHANGE}/${UNIT}
    base_sha: ${baseSha}
    writer: alice
    write_paths:
      - src/**
    depends_on: []
    verify:
${verify.map((command) => `      - ${JSON.stringify(command)}`).join('\n')}
`);
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(root, '.github/pull_request_template.md'), `## Change
- Change ID:
- Work Unit ID:
- Base SHA:
- Head SHA:

## Verification evidence
- [ ] Command, target SHA, and exit code recorded below
- [ ] Checks not run are listed below

\`\`\`text
command | target | exit code
\`\`\`

## AI provenance
- Writer/tool/run ID:
`);
  initRepo(root);
  git(['add', 'changes', 'services/registry.yaml', '.github'], root);
  git(['commit', '-qm', 'approved plan'], root);
  const planSha = git(['rev-parse', 'HEAD'], root);

  execFileSync(process.execPath, [
    BOOTSTRAP,
    '--change', CHANGE, '--unit', UNIT, '--writer', 'alice', '--run', RUN,
    '--plan-sha', planSha, '--apply',
  ], { cwd: root });

  return { base, root, service, serviceOrigin, baseSha, planSha };
}

function stubGh(responses = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command !== 'gh') return defaultRun(command, args, options);
    const key = args.join(' ');
    const match = Object.keys(responses).find((prefix) => key.startsWith(prefix));
    const value = match ? responses[match] : { status: 0, stdout: '' };
    return { command, args, status: value.status ?? 0, stdout: value.stdout ?? '', stderr: '' };
  };
  return { calls, run };
}

function packetFile(root) {
  return join(root, '.task-packets', `${RUN}.md`);
}

function rewritePacket(root, transform) {
  const path = packetFile(root);
  const body = transform(readFileSync(path, 'utf8').split('\nPacket SHA-256: ')[0]);
  writeFileSync(path, `${body}\nPacket SHA-256: ${sha256(`${body}\n`)}\n`, 'utf8');
}

test('start refuses a task packet whose digest no longer matches', () => {
  const { base, root } = fixture();
  try {
    const path = packetFile(root);
    writeFileSync(path, readFileSync(path, 'utf8').replace('- Goal:', '- Goal: tampered'), 'utf8');
    const writer = createWriter({ root });
    assert.throws(() => writer.start({ packet: RUN }), /변조/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('start refuses a task packet that disagrees with the approved plan', () => {
  const { base, root } = fixture();
  try {
    rewritePacket(root, (body) => body.replace(/- Base SHA: [0-9a-f]{40}/, `- Base SHA: ${'b'.repeat(40)}`));
    const writer = createWriter({ root });
    assert.throws(() => writer.start({ packet: RUN }), /승인된 계획과 다릅니다/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('start without --apply changes nothing', () => {
  const { base, root, service } = fixture();
  try {
    const writer = createWriter({ root });
    const result = writer.start({ packet: RUN });
    assert.equal(result.applied, false);
    assert.match(result.prompt, /push, PR 생성, merge는 하지 마세요/);
    assert.equal(git(['branch', '--show-current'], service), 'main');
    assert.equal(existsSync(join(root, '.task-packets', `${RUN}.state.json`)), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check records the real exit code of every declared command', () => {
  const { base, root } = fixture({ verify: ['node -e "process.exit(0)"', 'node -e "process.exit(3)"'] });
  try {
    const writer = createWriter({ root });
    writer.start({ packet: RUN, apply: true });
    const result = writer.check({ packet: RUN });
    assert.equal(result.passed, false);
    assert.deepEqual(result.commands.map(({ exitCode }) => exitCode), [0, 3]);
    assert.equal(typeof result.commands[1].output, 'string');
    assert.equal(result.scopeCheck.exitCode, 0);
    const state = JSON.parse(readFileSync(join(root, '.task-packets', `${RUN}.state.json`), 'utf8'));
    assert.equal(state.lastCheck.commands[1].exitCode, 3);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check keeps the output of a command the workspace cannot run', () => {
  const { base, root } = fixture({ verify: ['definitely-not-a-real-command'] });
  try {
    const writer = createWriter({ root });
    writer.start({ packet: RUN, apply: true });
    const result = writer.check({ packet: RUN });
    assert.equal(result.passed, false);
    assert.equal(result.commands[0].exitCode, 127);
    assert.match(result.commands[0].output, /not found/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('check fails when the workspace leaves the declared write scope', () => {
  const { base, root, service } = fixture();
  try {
    const writer = createWriter({ root });
    writer.start({ packet: RUN, apply: true });
    writeFileSync(join(service, 'README.md'), 'edited outside scope\n');
    const result = writer.check({ packet: RUN });
    assert.equal(result.passed, false);
    assert.notEqual(result.scopeCheck.exitCode, 0);
    assert.match(result.scopeCheck.output, /scope violation: README\.md/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('commit stages only the declared paths and adds the trailers', () => {
  const { base, root, service } = fixture();
  try {
    const writer = createWriter({ root });
    writer.start({ packet: RUN, apply: true });
    writeFileSync(join(service, 'src/index.js'), 'export const value = 2;\n');
    writeFileSync(join(service, 'notes.txt'), 'scratch\n');
    const result = writer.commit({ packet: RUN, message: 'feat: 값을 바꾼다', apply: true });
    assert.equal(result.applied, true);
    const message = git(['log', '-1', '--pretty=%B'], service);
    assert.match(message, new RegExp(`Change-ID: ${CHANGE}`));
    assert.match(message, new RegExp(`Work-Unit: ${UNIT}`));
    assert.match(message, new RegExp(`Agent-Run-ID: ${RUN}`));
    assert.equal(git(['show', '--name-only', '--pretty=', 'HEAD'], service), 'src/index.js');
    assert.match(git(['status', '--porcelain'], service), /\?\? notes\.txt/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pr refuses evidence that belongs to an earlier commit', () => {
  const { base, root, service } = fixture();
  try {
    const writer = createWriter({ root });
    writer.start({ packet: RUN, apply: true });
    writeFileSync(join(service, 'src/index.js'), 'export const value = 2;\n');
    git(['add', 'src/index.js'], service);
    git(['commit', '-qm', 'first'], service);
    writer.check({ packet: RUN });
    writeFileSync(join(service, 'src/index.js'), 'export const value = 3;\n');
    git(['add', 'src/index.js'], service);
    git(['commit', '-qm', 'second'], service);
    assert.throws(() => writer.pr({ packet: RUN, apply: true }), /검증 증거가 현재 커밋과 다릅니다/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('pr refuses while a declared check is failing unless the writer opts in', () => {
  const { base, root, service } = fixture({ verify: ['node -e "process.exit(4)"'] });
  try {
    const { run } = stubGh({ 'pr list': { stdout: '[]' }, 'pr create': { stdout: 'https://github.com/acme/api/pull/9' } });
    const writer = createWriter({ root, run });
    writer.start({ packet: RUN, apply: true });
    writeFileSync(join(service, 'src/index.js'), 'export const value = 2;\n');
    writer.commit({ packet: RUN, message: 'feat: 값을 바꾼다', apply: true });
    assert.throws(() => writer.pr({ packet: RUN, apply: true }), /실패한 검증이 1건/);
    const forced = writer.pr({ packet: RUN, apply: true, allowFailingChecks: true });
    assert.equal(forced.pr.number, 9);
    assert.match(forced.body, /node -e "process.exit\(4\)" \| [0-9a-f]{40} \| 4/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the full cycle pushes and opens one pull request without merging', () => {
  const { base, root, service, serviceOrigin } = fixture();
  try {
    const { calls, run } = stubGh({ 'pr list': { stdout: '[]' }, 'pr create': { stdout: 'https://github.com/acme/api/pull/11' } });
    const writer = createWriter({ root, run });
    writer.start({ packet: RUN, apply: true });
    writeFileSync(join(service, 'src/index.js'), 'export const value = 2;\n');
    writer.commit({ packet: RUN, message: 'feat: 값을 바꾼다', apply: true });
    const handoff = writer.handoff({ packet: RUN, apply: true });
    const result = writer.pr({ packet: RUN, agent: 'claude-code', apply: true });

    assert.equal(result.pr.number, 11);
    assert.match(readFileSync(handoff.path, 'utf8'), /Checks not run: 없음/);
    assert.match(result.body, new RegExp(`- Change ID: ${CHANGE}`));
    assert.match(result.body, /- \[x\] Command, target SHA, and exit code recorded below/);
    assert.match(result.body, /- Writer\/tool\/run ID: alice \/ claude-code \//);
    assert.match(result.body, /workflow-check \| [0-9a-f]{40} \| 0/);

    assert.ok(calls.some((call) => call.startsWith('git -C') && call.includes(`push -u origin feat/${CHANGE}/${UNIT}`)));
    assert.equal(calls.some((call) => call.startsWith('gh pr merge')), false);
    assert.equal(calls.some((call) => call.includes('--force')), false);
    assert.equal(calls.some((call) => /push\b.*\borigin main\b/.test(call)), false);
    assert.equal(git(['rev-parse', `refs/heads/feat/${CHANGE}/${UNIT}`], serviceOrigin), git(['rev-parse', 'HEAD'], service));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
