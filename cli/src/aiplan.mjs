// setup 때 Claude Code(claude -p)에게 "어떤 실행 경로를 기록기 경유로 감쌀지" 판단만 맡긴다.
// - 보내는 것: 셸 설정 중 'claude'가 들어간 alias·함수 줄만. 키·토큰으로 보이는 값은 가린다.
// - 도구는 모두 막는다(파일을 읽거나 고칠 수 없음). 답은 JSON 한 개.
// - 적용은 shell.mjs가 결정적으로 한다(원래 줄 불변, uninstall 시 원복). 실패하면 규칙 기반으로 돌아간다.
// - 이 요청은 기록기를 거치므로, 장부에 한 줄이 늘면 "기록 연결 테스트"도 통과한 것이다.
import { spawn } from 'node:child_process';

const SECRET = /((?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*)\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi;
export const redact = s => s.replace(SECRET, '$1<redacted>').replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\s+\S+)/g, '<redacted>');

// 셸 설정에서 claude 관련 alias 줄과 함수 블록만 뽑는다.
export function launcherSnippets(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*alias\s+[A-Za-z0-9_.-]+=/.test(l) && /claude/.test(l)) { out.push(redact(l.trim())); continue; }
    const fn = /^\s*(?:function\s+)?([A-Za-z0-9_.-]+)\s*\(\)\s*\{?\s*$/.exec(l);
    if (fn) {
      let depth = 0, body = [];
      for (let j = i; j < lines.length && j < i + 60; j++) {
        body.push(lines[j]);
        depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
        if (depth <= 0 && j > i) { i = j; break; }
      }
      if (body.some(b => /claude/.test(b))) out.push(redact(body.join('\n')));
    }
  }
  return out;
}

const PROMPT = `너는 셸 설정 분석기다. 아래는 사용자의 셸 설정 중 Claude Code 실행과 관련된 alias·함수다.
목표: Claude 구독 계정으로 api.anthropic.com에 "직접" 가는 실행 경로만 로컬 기록기(jinsil claude)를 거치게 감싼다.
규칙:
- 감쌀 alias: 값이 claude 로 시작하고 ANTHROPIC_BASE_URL·ANTHROPIC_AUTH_TOKEN 등으로 다른 서버(라우터·로컬 모델·프록시)를 가리키지 않는 것.
- 감싸지 말 alias: 다른 모델/라우터/프록시로 가는 것(예: ANTHROPIC_BASE_URL=..., ocx, teamclaude, ollama 등), claude가 아닌 명령.
- wrap_claude: 사용자가 그냥 'claude'를 입력했을 때도 감쌀지. 사용자가 정의한 claude() 함수가 라우팅(다른 BASE_URL로 보내는 분기)을 하면, 감싸면 그 분기가 무시된다는 점을 note에 적고 기본적으로는 true로 둔다(직접 경로가 주 경로이므로). 함수가 항상 다른 서버로 보내면 false.
오직 JSON 하나만 출력: {"wrap":["alias이름",...],"wrap_claude":true|false,"skip":[{"name":"...","reason":"한국어 짧게"}],"notes":["한국어 짧게"]}`;

export function planWithClaude(snippets, { port, timeoutMs = 90000, bin = process.env.JINSIL_CLAUDE_BIN || 'claude' } = {}) {
  return new Promise(resolve => {
    const env = { ...process.env };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[k];
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    const input = `${PROMPT}\n\n--- 셸 설정 발췌 ---\n${snippets.length ? snippets.join('\n\n') : '(claude 관련 alias·함수 없음)'}\n`;
    let child;
    try {
      child = spawn(bin, ['-p', '--output-format', 'json', '--no-session-persistence',
        '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task'],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return resolve({ ok: false, reason: 'claude_not_found' }); }
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', b => { out += b; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, reason: 'claude_not_found' }); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, reason: `claude_exit_${code}` });
      try {
        const text = JSON.parse(out).result ?? out;
        const j = JSON.parse(/\{[\s\S]*\}/.exec(text)[0]);
        resolve({ ok: true, plan: {
          wrap: Array.isArray(j.wrap) ? j.wrap.filter(n => typeof n === 'string') : [],
          wrapClaude: j.wrap_claude !== false,
          skip: Array.isArray(j.skip) ? j.skip.filter(s => s && typeof s.name === 'string').map(s => ({ name: s.name, reason: String(s.reason || '') })) : [],
          notes: Array.isArray(j.notes) ? j.notes.map(String).slice(0, 5) : [],
        } });
      } catch { resolve({ ok: false, reason: 'bad_json' }); }
    });
    child.stdin.end(input);
  });
}
