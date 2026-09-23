#!/usr/bin/env node
// 클진요 CLI. 설치만으로는 아무것도 바뀌지 않는다 — setup을 실행해야 기록기가 켜진다.
import { run } from '../src/cli.mjs';

run(process.argv.slice(2)).then(code => { process.exitCode = code ?? 0; }, e => {
  console.error(`[jinsil] ${/^[a-z_0-9]+$/.test(e?.message) ? e.message : 'failed'}${process.env.JINSIL_DEBUG ? '\n' + e.stack : ''}`);
  process.exitCode = 1;
});
