import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const metadata = new Set(['README', 'README.md', '.gitignore', 'LICENSE', 'LICENSE.md']);
const removedOwnerFile = '.github/CODEOWNERS';

export function verifySetupPointer({ root, path, before, after, service, receipt }) {
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const pointer = (ref) => {
    const match = git(['ls-tree', ref, '--', path]).match(/^160000 commit ([0-9a-f]{40})\t/);
    if (!match) throw new Error(`${path}: setup requires an existing gitlink`);
    return match[1];
  };
  const base = pointer(before);
  const head = pointer(after);
  if (!receipt || receipt.repo !== service.id || receipt.state !== 'merged'
    || receipt.base_sha !== base || receipt.merge_sha !== head) {
    throw new Error(`${path}: setup receipt does not match exact base/merge pointers`);
  }
  const cwd = join(root, path);
  const lines = (value) => value.split('\n').filter(Boolean);
  const prior = lines(git(['ls-tree', '-r', '--name-only', base], cwd));
  const final = lines(git(['ls-tree', '-r', '--name-only', head], cwd));
  if (!prior.length || !final.length || prior.some((file) => !metadata.has(file) && file !== removedOwnerFile)
    || final.some((file) => !metadata.has(file))) {
    throw new Error(`${path}: product files are not eligible for metadata-only setup`);
  }
  const range = lines(git(['rev-list', '--first-parent', `${base}..${head}`], cwd));
  if (range.length !== 1 || range[0] !== receipt.merge_sha
    || git(['rev-parse', `${head}^1`], cwd) !== base) {
    throw new Error(`${path}: setup must pin exactly one recorded service merge`);
  }
  const changed = lines(git(['diff', '--name-only', base, head], cwd));
  if (changed.some((file) => !metadata.has(file) && file !== removedOwnerFile)) {
    throw new Error(`${path}: setup diff is not metadata-only`);
  }
  return true;
}
