// 수집기 v2: Claude Code 대화 파일(~/.claude/projects/**/*.jsonl)에서 assistant 메시지의 usage만 읽는다.
// - 요청 경로에 끼어들지 않는다. 본문(content)·경로·세션 ID는 장부에 남기지 않는다.
// - 파일별 {ino, offset}로 증분 읽기. 끝에 줄바꿈이 없는 마지막 줄은 다음에 다시 읽는다(쓰는 중).
//   inode가 바뀌거나 파일이 줄면 처음부터 다시 읽는다 — 메시지 키로 중복 제거하므로 안전.
// - 같은 message.id가 여러 줄 반복된다(블록마다). 합산하지 않고 마지막 usage로 교체한다.
// - 집계 대상: 단가표에 있는 표준 모델명 + requestId가 req_로 시작(Anthropic 직결 응답 헤더). 그 외는 사유별 개수만.
//   라우터 경유는 모델명이 비표준(claude-ocx-… 등)이거나 requestId가 없다(09-23 실측: 45k줄 중 req_ 5.2k).
// - usage.iterations는 상위 usage에 이미 포함돼 있어 더하지 않는다(09-23 실측: 단일 iteration = 상위값).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRICES } from './prices.mjs';

export const projectsRoot = () => process.env.JINSIL_CLAUDE_PROJECTS || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// assistant 한 줄 → 메시지 레코드 또는 제외 사유
export function parseLine(line) {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  let j; try { j = JSON.parse(line); } catch { return { excluded: 'bad_json' }; }
  if (j.type !== 'assistant') return null;
  const m = j.message || {}, u = m.usage;
  if (!u || !m.id) return null;
  if (j.isApiErrorMessage || m.model === '<synthetic>') return { excluded: 'synthetic_or_error' };
  if (!Object.hasOwn(PRICES, m.model)) return { excluded: 'nonstandard_model' };
  if (typeof j.requestId !== 'string' || !j.requestId.startsWith('req_')) return { excluded: 'no_direct_request_id' };
  const ts = Date.parse(j.timestamp);
  if (!Number.isFinite(ts)) return { excluded: 'bad_timestamp' };
  const n = v => (Number.isInteger(v) && v >= 0 ? v : 0);
  const cc = u.cache_creation;
  const w5 = cc ? n(cc.ephemeral_5m_input_tokens) : 0, w1 = cc ? n(cc.ephemeral_1h_input_tokens) : 0;
  const total = n(u.cache_creation_input_tokens);
  const tokens = { input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens),
    cache_write_5m: w5, cache_write_1h: w1, cache_write_unknown: cc ? Math.max(0, total - w5 - w1) : total };
  // 정가 표준 요금이 아닌 사용: fast 모드, 서버 도구(웹 검색·페치). 창 제외 판단용으로 따로 센다.
  const special = {};
  if (u.speed && u.speed !== 'standard') special.nonstandard_speed = 1;
  const st = u.server_tool_use || {};
  if (n(st.web_search_requests)) special.web_search_requests = n(st.web_search_requests);
  if (n(st.web_fetch_requests)) special.web_fetch_requests = n(st.web_fetch_requests);
  return { key: `${m.id}:${j.requestId}`, ts, model: m.model, tokens, special, sidechain: !!j.isSidechain };
}

// state: { files: {path: {ino, offset}}, messages: {key: rec}, excluded: {reason: n} }
export function scan(state, { root = projectsRoot(), since = 0, now = Date.now(), keepMs = 8 * 86400000 } = {}) {
  state.files ||= {}; state.messages ||= {}; state.excluded ||= {};
  let changed = 0;
  for (const file of walk(root)) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < since - 60000) continue; // 연결 이전 파일은 보지 않는다(소급 귀속 금지)
    const prev = state.files[file];
    let offset = prev && prev.ino === st.ino && st.size >= prev.offset ? prev.offset : 0;
    if (offset === st.size) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end < 0) { state.files[file] = { ino: st.ino, offset }; continue; }
      for (const line of text.slice(0, end).split('\n')) {
        const r = parseLine(line);
        if (!r) continue;
        if (r.excluded) { state.excluded[r.excluded] = (state.excluded[r.excluded] || 0) + 1; continue; }
        if (r.ts < since) { state.excluded.before_connect = (state.excluded.before_connect || 0) + 1; continue; }
        const old = state.messages[r.key];
        if (!old || r.ts >= old.ts) { state.messages[r.key] = r; changed++; }
      }
      offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
    } finally { fs.closeSync(fd); }
    state.files[file] = { ino: st.ino, offset };
  }
  for (const [k, r] of Object.entries(state.messages)) if (now - r.ts > keepMs) delete state.messages[k];
  for (const f of Object.keys(state.files)) if (!fs.existsSync(f)) delete state.files[f];
  return changed;
}

export const lastActivity = state => Object.values(state.messages || {}).reduce((m, r) => Math.max(m, r.ts), 0);
