import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { safeIdentifier, sha256 } from '../lib.mjs';

const DIGEST_MARKER = 'Packet SHA-256: ';

export function packetPath(root, reference) {
  const value = String(reference ?? '').trim();
  if (!value) throw new Error('작업 지시서 이름 또는 경로가 필요합니다.');
  if (value.includes('/') || value.endsWith('.md')) {
    const path = isAbsolute(value) ? value : resolve(root, value);
    if (!path.startsWith(resolve(root))) throw new Error('작업 지시서 경로가 Root 밖을 벗어납니다.');
    return path;
  }
  return join(resolve(root), '.task-packets', `${safeIdentifier('run ID', value)}.md`);
}

function sections(text) {
  const result = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^#\s+(.+)$/);
    if (heading) {
      current = heading[1].trim();
      result.set(current, []);
      continue;
    }
    if (current) result.get(current).push(line);
  }
  return result;
}

function field(lines, label) {
  const match = lines.find((line) => line.startsWith(`- ${label}: `));
  return match ? match.slice(`- ${label}: `.length).trim() : '';
}

function indentedList(lines, label) {
  const start = lines.findIndex((line) => line.trim() === `- ${label}`);
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  - ')) break;
    items.push(line.slice(4).trim());
  }
  return items;
}

export function parsePacket(text) {
  const digestIndex = text.lastIndexOf(`\n${DIGEST_MARKER}`);
  if (digestIndex < 0) throw new Error('작업 지시서에 Packet SHA-256 줄이 없습니다.');
  const body = text.slice(0, digestIndex + 1);
  const declaredDigest = text.slice(digestIndex + 1 + DIGEST_MARKER.length).trim();
  const parsed = sections(text);
  const task = parsed.get('TASK') ?? [];
  const scope = parsed.get('SCOPE') ?? [];
  const contract = parsed.get('CONTRACT') ?? [];
  const verifyHeading = [...parsed.keys()].find((name) => name.startsWith('VERIFY'));
  const verifyLines = verifyHeading ? parsed.get(verifyHeading) : [];

  const verify = verifyLines
    .filter((line) => line.startsWith('- ') && line.includes('(expect exit'))
    .map((line) => line.slice(2, line.lastIndexOf('(expect exit')).trim());

  return {
    body,
    declaredDigest,
    computedDigest: sha256(body),
    change: field(task, 'Change ID'),
    unit: field(task, 'Work Unit ID'),
    writer: field(task, 'Writer'),
    run: field(task, 'Run ID'),
    planSha: field(task, 'Plan SHA'),
    manifestDigest: field(task, 'Manifest SHA-256'),
    goal: field(task, 'Goal'),
    repo: field(scope, 'Repository'),
    branch: field(scope, 'Required branch'),
    baseSha: field(scope, 'Base SHA'),
    writePaths: indentedList(scope, 'Allowed paths:'),
    contracts: indentedList(contract, 'Approved contract snapshots (do not modify):')
      .map((line) => line.replace(/\s*\(sha256:[0-9a-f]{64}\)$/, '')),
    verify,
  };
}

export function readPacket(root, reference) {
  const path = packetPath(root, reference);
  if (!existsSync(path)) throw new Error(`작업 지시서를 찾을 수 없습니다: ${path}`);
  const packet = parsePacket(readFileSync(path, 'utf8'));
  if (packet.declaredDigest !== packet.computedDigest) {
    throw new Error(`작업 지시서가 변조되었거나 손상되었습니다. 기록된 해시 ${packet.declaredDigest}, 실제 ${packet.computedDigest}`);
  }
  for (const [label, value] of [['Change ID', packet.change], ['Work Unit ID', packet.unit], ['Writer', packet.writer], ['Run ID', packet.run]]) {
    if (!value) throw new Error(`작업 지시서에 ${label}가 없습니다.`);
  }
  return { ...packet, path };
}

// The packet is a copy. The approved plan at the plan SHA is the original.
export function assertMatchesPlan(packet, unit, verifyCommands) {
  const mismatches = [];
  if (unit.branch !== packet.branch) mismatches.push(`브랜치 ${packet.branch} ≠ 계획 ${unit.branch}`);
  if (unit.base_sha !== packet.baseSha) mismatches.push(`base SHA ${packet.baseSha} ≠ 계획 ${unit.base_sha}`);
  if (String(unit.repo) !== packet.repo) mismatches.push(`저장소 ${packet.repo} ≠ 계획 ${unit.repo}`);
  const planPaths = [...unit.write_paths].sort().join(', ');
  const packetPaths = [...packet.writePaths].sort().join(', ');
  if (planPaths !== packetPaths) mismatches.push(`수정 경로 [${packetPaths}] ≠ 계획 [${planPaths}]`);
  const planVerify = verifyCommands.join(' | ');
  const packetVerify = packet.verify.join(' | ');
  if (planVerify !== packetVerify) mismatches.push(`검증 명령 [${packetVerify}] ≠ 계획 [${planVerify}]`);
  if (mismatches.length) {
    throw new Error(`작업 지시서가 승인된 계획과 다릅니다.\n- ${mismatches.join('\n- ')}\n지시서를 다시 발급받으세요.`);
  }
}
