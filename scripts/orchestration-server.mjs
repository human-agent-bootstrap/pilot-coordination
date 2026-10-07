#!/usr/bin/env node
import { createOrchestrationServer } from './orchestration/server.mjs';

const host = '127.0.0.1';
const rawPort = process.env.PORT ?? '4173';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`ERROR: invalid PORT ${rawPort}\n`);
  process.exitCode = 1;
} else {
  const server = createOrchestrationServer({ root: process.cwd() });
  server.listen(port, host, () => {
    const address = server.address();
    const url = `http://${host}:${address.port}/#token=${server.coordinationToken}`;
    process.stdout.write(`Coordination meeting UI: ${url}\n`);
    process.stdout.write(`Root: ${process.cwd()}\n`);
    process.stdout.write('이 주소를 그대로 여세요. 토큰은 계획 PR 생성에만 사용하며 이 세션에서만 유효합니다.\n');
  });
}
