import { defaultRun } from './lib.mjs';

export function githubSlug(value, host = 'github.com') {
  const ssh = String(value ?? '').match(/^git@([^:]+):(.+)$/);
  const url = ssh ? null : new URL(value);
  if ((ssh?.[1] ?? url.hostname) !== host || (url && (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash))) {
    throw new Error(`repository URL must use ${host} without credentials`);
  }
  const slug = (ssh?.[2] ?? url.pathname).replace(/^\/|\.git$|\/$/g, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) throw new Error('invalid GitHub repository URL');
  return slug;
}

export function redact(value, env = process.env) {
  let text = String(value ?? '');
  for (const [key, secret] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|PAT$/.test(key) && secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/g, '$1[redacted]@');
}

export function localCheckEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|PAT$|SSH_AUTH_SOCK|SSH_AGENT_PID|NODE_TEST_CONTEXT/i.test(key)));
}

// Reuse gh's authenticated requests, never extract its saved token.
export function createGithub({ cwd, registry = {}, env = process.env, fetchImpl = fetch, run = defaultRun } = {}) {
  const host = registry.github?.host ?? 'github.com';
  const apiBase = registry.github?.api_base ?? (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`);
  const token = env.COORDINATION_GITHUB_TOKEN || env.GH_ENTERPRISE_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN;
  async function get(path) {
    if (!path.startsWith('/repos/')) throw new Error('unsupported GitHub API path');
    if (token) {
      const response = await fetchImpl(`${apiBase}${path}`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
      return response.json();
    }
    if (env.CI) throw new Error('CI requires COORDINATION_GITHUB_TOKEN or an existing GitHub token environment variable');
    const result = await run('gh', ['api', '--hostname', host, path, '--method', 'GET'], { cwd, env });
    if (result.status !== 0) throw new Error(`GitHub 조회 실패. gh 인증을 확인하세요: ${redact(result.stderr || result.stdout, env)}`);
    return JSON.parse(result.stdout);
  }
  async function list(path) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const rows = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('GitHub list response must be an array');
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  }
  return { get, list, host };
}
