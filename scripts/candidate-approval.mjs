import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultRun, sha256 } from './lib.mjs';
import { assertPathHasNoSymlinks } from './orchestration/change-service.mjs';

// The Coordinator-held original supplies authority; an agent-controlled digest alone does not.
export function validateCandidateApproval(path, { cwd, change, unit, planSha, run = defaultRun, agent = false } = {}) {
  const original = resolve(path);
  const text = readFileSync(original, 'utf8');
  const approval = JSON.parse(text);
  if (approval.kind !== 'candidate-execution' || approval.schemaVersion !== 1
    || original !== join(resolve(approval.coordinatorRoot), '.task-packets', `${approval.run}.candidate-approval.json`)
    || approval.change !== change || approval.unit !== unit || approval.planSha !== planSha
    || resolve(approval.workspace) !== resolve(cwd)) throw new Error('Candidate approval identity or workspace mismatch');
  const statePath = join(dirname(original), `${approval.run}.candidate-state.json`);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const digest = sha256(text);
  if (state.approvalDigest !== digest || state.workspace !== approval.workspace) throw new Error('Candidate approval original was altered');
  assertPathHasNoSymlinks(approval.coordinatorRoot, `.task-packets/${approval.run}.candidate-approval.json`);
  assertPathHasNoSymlinks(approval.coordinatorRoot, `.task-packets/${approval.run}.candidate-state.json`);
  assertPathHasNoSymlinks(approval.coordinatorRoot, `.task-packets/candidate-workspaces/${approval.run}`);
  const git = (args, directory = approval.coordinatorRoot) => {
    const result = run('git', args, { cwd: directory });
    if (result.status !== 0) throw new Error('Candidate approval Git input unavailable');
    return result.stdout.trim();
  };
  if (git(['rev-parse', 'origin/main']) !== approval.baseSha) throw new Error('Candidate approval Root base is stale');
  if (agent) {
    if (state.phase !== 'agent') throw new Error('Candidate agent lease is not active');
    const copy = join(cwd, '.task-packets', `${approval.run}.candidate-approval.json`);
    const packet = join(cwd, '.task-packets', `${approval.run}.candidate.md`);
    const packetOriginal = join(dirname(original), `${approval.run}.candidate.md`);
    if (!existsSync(copy) || sha256(readFileSync(copy)) !== digest || sha256(readFileSync(packet)) !== state.packetDigest
      || sha256(readFileSync(packetOriginal)) !== state.packetDigest) throw new Error('Candidate approval or packet copy was altered');
    if (git(['ls-files', '--stage', '--', ':(exclude)e2e/**'], cwd) !== state.agentBaseline.index
      || git(['diff', '--name-only', `${state.agentBaseline.head}..HEAD`, '--', ':(exclude)e2e/**'], cwd)) {
      throw new Error('Agent modified or committed files outside e2e/**');
    }
  }
  for (const service of approval.services) {
    const directory = join(cwd, service.path);
    if (git(['rev-parse', 'HEAD'], directory) !== service.sha || git(['status', '--porcelain'], directory)) throw new Error('Candidate service snapshot was altered');
    if (agent && git(['ls-files', '--stage', '--', service.path], cwd).match(/^160000 ([0-9a-f]{40}) /)?.[1] !== service.baseSha) {
      throw new Error('Agent staged a Coordinator-owned service pointer');
    }
  }
  for (const contract of approval.contracts) {
    if (sha256(readFileSync(join(cwd, contract.path))) !== contract.digest) throw new Error('Candidate contract was altered');
  }
  return { approval, state, digest };
}
