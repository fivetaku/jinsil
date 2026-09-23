// 웹 페이지 (캠페인형 볼드: 노란 슬로건 띠 + 검정 블록 + 흰 데이터 영역). 데이터 영역에는 선동 문구를 두지 않는다.
import { html, esc, PLAN_LABEL } from './util.js';
import { publicStats, feed, EXCLUDE_KO } from './stats.js';
import { currentUser } from './auth.js';

const usd = (n, d = 0) => n === null || n === undefined ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })}`;
const x = n => n === null || n === undefined ? '—' : `${Math.round(n)}배`;
const kst = iso => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
const gaugeLabel = g => g === '7d' ? '주간' : '5시간';

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif;color:#111;background:#fff;-webkit-font-smoothing:antialiased}
a{color:inherit}.wrap{max-width:1200px;margin:0 auto;padding:0 24px}
.top{background:#111;color:#fff}.top .wrap{display:flex;align-items:center;justify-content:space-between;height:56px;gap:16px}
.logo{font-weight:900;font-size:24px;letter-spacing:-1px;text-decoration:none}.logo small{font-weight:500;font-size:13px;opacity:.8;margin-left:12px;letter-spacing:0}
.nav{display:flex;gap:18px;align-items:center;font-size:14px}.nav a{text-decoration:none}
.btn{display:inline-block;background:#FFD400;color:#111;font-weight:800;border:0;border-radius:6px;padding:9px 16px;font-size:14px;text-decoration:none;cursor:pointer}
.btn.dark{background:#111;color:#fff}.btn.ghost{background:#fff;border:2px solid #111}
.band{background:#FFD400;border-bottom:4px solid #111}.band h1{margin:0;padding:28px 0 22px;font-size:clamp(34px,7vw,84px);font-weight:900;letter-spacing:-3px;line-height:1;text-align:center}
.band .join{word-break:keep-all;margin:0;padding:0 0 22px;text-align:center;font-size:clamp(15px,1.9vw,20px);font-weight:800;letter-spacing:-.3px}
.band .join code{background:#111;color:#FFD400;font-size:.95em;padding:4px 10px;border-radius:6px;font-weight:700}
.band .live{word-break:keep-all;margin:-12px 0 0;padding:0 0 20px;text-align:center;font-size:14px;font-weight:600}.band .live b{font-weight:900}
.band .join a{font-weight:600;font-size:.8em;margin-left:8px;opacity:.75}
.caution{border:2px solid #111;border-left:8px solid #D62828;background:#fff;padding:10px 14px;margin:22px 0 0;font-size:14px;word-break:keep-all}.caution ul{margin:6px 0 0;padding-left:18px}.caution li{margin:2px 0}
.lead{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;margin:34px 0 18px}.lead h2{margin:0;font-size:clamp(26px,3.6vw,40px);font-weight:900;letter-spacing:-1.5px}
.lead h2 mark{background:linear-gradient(transparent 55%,#FFD400 55%);color:inherit}.lead p{margin:0;color:#555;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.card{position:relative;border:3px solid #111;border-radius:6px;background:#fff;min-height:190px}
.card.best{border-color:#E6B800;box-shadow:0 0 0 3px #FFD400}
.card .hd{background:#111;color:#fff;font-weight:900;font-size:20px;padding:10px 16px;display:flex;justify-content:space-between}
.card.best .hd{background:#FFD400;color:#111}.card .hd span{font-weight:600;font-size:15px}
.card .bd{padding:18px 16px 16px;text-align:center}.big{font-size:56px;font-weight:900;letter-spacing:-2px;line-height:1.05}.big.muted{color:#999;font-size:40px}
.sub{font-size:17px;font-weight:700;margin-top:6px}.meta{font-size:13px;color:#666;margin-top:6px}
.stickers{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:12px}
.st{display:inline-block;font-weight:900;font-size:13px;padding:6px 10px;border:2px solid #111;background:#fff;box-shadow:2px 2px 0 #111;transform:rotate(-2deg)}
.st.best{background:#FFD400;transform:rotate(3deg)}.st.less{background:#D62828;color:#fff;border-color:#8a1111;transform:rotate(-3deg)}
.st.waiting{background:#666;color:#fff;border-color:#333}.st.baseline{background:#111;color:#fff}.st.multiple{transform:rotate(1deg)}
.panel{border:2px solid #111;border-radius:6px;margin-top:22px;padding:18px 18px 14px}
.tab{display:inline-block;background:#111;color:#fff;font-weight:900;padding:6px 14px;border-radius:4px 4px 0 0;margin:26px 0 -2px;font-size:16px}
.tab+.panel{margin-top:0;border-top-left-radius:0}
.bars .row{display:grid;grid-template-columns:130px 1fr 90px;align-items:center;gap:10px;margin:8px 0;font-weight:800}
.bar{height:26px;background:#f2f2f2;position:relative}.bar i{position:absolute;left:0;top:0;bottom:0;background:#111}.bar i.hi{background:#FFD400;border:2px solid #111}
.bar.wait{background:repeating-linear-gradient(45deg,#fff,#fff 6px,#eee 6px,#eee 12px);border:2px dashed #999}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-weight:700;color:#555;border-bottom:2px solid #111;padding:8px 6px}
td{padding:8px 6px;border-bottom:1px solid #eee}td.num{font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#2a9d4a;margin-right:6px}.dot.g{background:#aaa}.dot.r{background:#D62828}
.feeds{display:grid;grid-template-columns:1fr 1fr;gap:22px}.feeds h3{margin:0 0 8px;font-size:17px}
.sub{margin:26px 0 12px;font-size:20px;font-weight:900}.sub small{font-size:13px;font-weight:500;color:#666;margin-left:8px}
.cards.team{grid-template-columns:repeat(2,1fr);max-width:66.6%}
.ranks{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.ranks h3{margin:0 0 8px;font-size:17px}
.foot{text-align:center;color:#666;font-size:13px;margin:40px 0 30px}
.note{font-size:13px;color:#666;margin:10px 0 0}.warn{background:#fff6cc;border:2px solid #111;padding:10px 14px;font-size:14px;margin-top:14px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.kpi{border:2px solid #111;padding:14px}.kpi b{display:block;font-size:30px;font-weight:900;letter-spacing:-1px}.kpi span{font-size:13px;color:#555}
code,pre{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:13px}pre{padding:12px;overflow:auto}
.prose{max-width:780px;line-height:1.75;font-size:16px}.prose h2{margin-top:32px}
@media (max-width:820px){.cards,.cards.team,.ranks,.kpis,.feeds{grid-template-columns:1fr;max-width:none}.logo small{display:none}.nav a.hide-m{display:none}.big{font-size:48px}
.bars .row{grid-template-columns:70px 1fr 64px}.hide-m{display:none}.top .wrap{padding:0 14px}.wrap{padding:0 14px}th,td{padding:7px 4px;font-size:13px}}
@media print{.top,.band,.noprint{display:none}.panel{break-inside:avoid}}`;

function layout(title, body, { user = null } = {}) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="Claude 구독 한도 1%는 얼마일까. 참여자 PC에서 측정한 실제 토큰으로 요금제별 가성비를 공개합니다.">
<meta property="og:type" content="website"><meta property="og:site_name" content="클진요"><meta property="og:locale" content="ko_KR">
<meta property="og:title" content="클진요 — 클로드에게 진실을 요구합니다"><meta property="og:description" content="Claude 구독 한도 1%는 얼마일까. 참여자 PC에서 측정한 실제 토큰으로 요금제별 가성비를 공개합니다.">
<meta property="og:url" content="https://jinsil.axwith.com/"><meta property="og:image" content="https://jinsil.axwith.com/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="클로드에게 진실을 요구합니다 — 구독료 1달러로 얼마나 쓸 수 있나">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="클진요 — 클로드에게 진실을 요구합니다"><meta name="twitter:image" content="https://jinsil.axwith.com/og.png">
<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="theme-color" content="#FFD400"><style>${CSS}</style></head><body>
<header class="top"><div class="wrap"><a class="logo" href="/">클진요<small>클로드에게 진실을 요구합니다</small></a>
<nav class="nav"><a href="/#stats" class="hide-m">통계</a><a href="/methodology">방법론</a><a href="/me">내 대시보드</a>
${user ? '' : '<a class="btn" href="/auth/google?next=/me">Google로 참여</a>'}</nav></div></header>${body}
<p class="foot">원본은 참여자 PC에만 남습니다 · 서버에는 계산값만</p></body></html>`;
}

const STAGE_KO = { provisional: '잠정', normal: '보통', precise: '정밀' };
const stageTxt = st => st ? `${STAGE_KO.precise} ${st.precise} · ${STAGE_KO.normal} ${st.normal} · ${STAGE_KO.provisional} ${st.provisional}` : '';
const exclTxt = ex => {
  const all = {};
  for (const g of Object.values(ex || {})) for (const [r, n] of Object.entries(g)) all[r] = (all[r] || 0) + n;
  const parts = Object.entries(all).map(([r, n]) => `${EXCLUDE_KO[r] || r} ${n}`);
  return parts.length ? parts.join(' · ') : '없음';
};

function planCard(p, sticks, bestPlan) {
  const s = (sticks[p.plan] || []).map(t => `<span class="st ${t.kind}">${esc(t.text)}</span>`).join('');
  const body = p.shown
    ? `<div class="big">${x(p.value_multiple)}</div><div class="sub">30일 환산 ≈ ${usd(p.monthly_value)}</div>
       <div class="meta">주간 100% 중앙값 ${usd(p.median_usd_per_100pct)} (측정 범위 ${usd(p.range_lo)}~${usd(p.range_hi)}) · ${p.n}계정 · ${stageTxt(p.stages)}</div>`
    : `<div class="big muted">구독료의 ?배</div><div class="meta">참여 ${p.participants}계정${p.participants > p.n ? ` (검증 중·데이터 부족 ${p.participants - p.n})` : ''} · 공개까지 ${Math.max(0, p.min_accounts - p.n)}계정 더</div>`;
  return `<div class="card ${bestPlan === p.plan ? 'best' : ''}"><div class="hd">${esc(p.label)}<span>월 ${usd(p.price)}</span></div>
    <div class="bd">${body}<div class="stickers">${s}</div></div></div>`;
}

export async function home(req, env) {
  const [s, f, user] = await Promise.all([publicStats(env), feed(env, 20), currentUser(req, env)]);
  const plans = ['pro', 'max5x', 'max20x'].map(k => s.plans[k]);
  const teamPlans = ['team_standard', 'team_premium'].map(k => s.plans[k]).filter(Boolean);
  const allPlans = [...plans, ...teamPlans];
  const best = Object.entries(s.stickers).find(([, v]) => v.some(t => t.kind === 'best'))?.[0];
  const maxMult = Math.max(1, ...allPlans.map(p => p.shown ? p.value_multiple : 0));
  const bars = allPlans.map(p => p.shown
    ? `<div class="row"><span>${esc(p.label)}</span><div class="bar"><i class="${best === p.plan ? 'hi' : ''}" style="width:${(p.value_multiple / maxMult * 100).toFixed(1)}%"></i></div><span>${x(p.value_multiple)}</span></div>`
    : `<div class="row"><span>${esc(p.label)}</span><div class="bar wait"></div><span style="color:#888">측정 대기</span></div>`).join('');
  const rankTables = allPlans.map(p => {
    const rows = s.ranking[p.plan];
    return `<div><h3>${esc(p.label)}</h3>${rows.length ? `<table><tr><th>순위</th><th>참여자</th><th>가성비</th><th class="hide-m">주간 100%</th><th>단계</th></tr>${rows.slice(0, 10).map(r =>
      `<tr><td>${r.rank}</td><td>#${esc(r.tag)}</td><td class="num">${(r.value_multiple).toFixed(1)}배</td><td class="num hide-m">${usd(r.usd_per_100pct)}</td><td>${STAGE_KO[r.stage] || ''}</td></tr>`).join('')}</table>`
      : `<p class="note">${p.shown ? '아직 순위에 오른 계정이 없습니다.' : `측정 대기 — 이 요금제 계정이 ${p.min_accounts}개 이상 모이면 순위를 공개합니다(현재 ${p.n}).`}</p>`}</div>`;
  }).join('');
  const feedTable = gauge => {
    const rs = f.filter(r => r.gauge === gauge);
    return `<table><tr><th>갱신(KST)</th><th>참여자</th><th>요금제</th><th>게이지</th><th>상태</th></tr>${rs.length ? rs.map(r => `<tr><td>${kst(r.at)}</td><td><span class="dot ${r.exclude_reason ? 'r' : r.state === 'final' ? '' : 'g'}"></span>#${esc(r.tag)}</td>
    <td>${esc(PLAN_LABEL[r.plan] || '미확인')}</td><td>${esc(r.range)}</td><td>${esc(r.display)}</td></tr>`).join('') : '<tr><td colspan="5" class="note">아직 없습니다(공개 기준을 채운 요금제만 표시).</td></tr>'}</table>`;
  };
  const excl = allPlans.map(p => `<tr><td>${esc(p.label)}</td><td>${esc(exclTxt(p.exclusions))}</td></tr>`).join('');
  return html(layout('클진요 — 클로드에게 진실을 요구합니다', `
<section class="band"><div class="wrap"><h1>클로드에게 진실을 요구합니다</h1><p class="join">터미널에서 <code>npx jinsil setup</code> 한 번이면 끝. 이후 평소처럼 Claude Code(터미널·IDE·SDK)를 쓰면 됩니다 <a href="/methodology">어떻게 계산하나요?</a></p><p class="live">지금 <b>${s.measuring.users}명</b>이 PC ${s.measuring.devices}대에서 측정 중 · 한도 창(5시간·주간) 단위로 자동 집계</p></div></section>
<main class="wrap" id="stats">
  <div class="caution"><b>측정 주의</b><ul>
    <li>같은 계정으로 claude.ai 채팅·모바일·다른 PC를 함께 쓰면 게이지만 올라 값이 낮게 나옵니다 — 이런 창은 "외부 사용 의심"으로 통계에서 뺍니다.</li>
    <li>여러 계정을 돌려 쓰는 풀·라우터 경유 사용은 계정을 나눌 수 없어 기본 집계에서 빠집니다(풀 사용자는 <code>--proxy</code> 모드).</li>
    <li>참여자가 로컬에서 관측해 제출한 값이며, 금액은 API 정가 환산 추정치입니다(실제 청구액 아님).</li></ul></div>
  <div class="lead"><h2>구독료 <mark>1달러로</mark> 얼마나 쓸 수 있나</h2><p>${esc(s.note)}${s.price_status === 'provisional' ? ' · 단가 잠정' : ''}</p></div>
  <div class="cards">${plans.map(p => planCard(p, s.stickers, best)).join('')}</div>
  <h3 class="sub">팀 요금제 <small>좌석당 월 결제가 · 요금제 등급 문자열이 실측으로 확인된 뒤 집계</small></h3>
  <div class="cards team">${teamPlans.map(p => planCard(p, s.stickers, best)).join('')}</div>
  <div class="tab">가성비 배수</div><div class="panel bars">${bars}
    <p class="note">가성비 배수 = (주간 100% 환산 × 30/7, 30일 환산) ÷ 월 구독료. 계정당 한 표, 계정 값의 중앙값${s.baseline ? ` · 가격→가치 비교 기준: ${esc(PLAN_LABEL[s.baseline])}` : ''}. 단계: 주간 게이지 누적 +5%p 잠정 → +8%p 보통 → +11%p 정밀.</p></div>
  <div class="tab">요금제별 순위</div><div class="panel"><div class="ranks">${rankTables}</div>
    <p class="note">순위가 낮을수록 같은 구독료로 한도를 더 빨리 쓰는 사용 패턴입니다(모델·캐시 구성에 따라 달라짐). 익명 태그만 공개합니다.</p></div>
  <div class="tab">통계에서 뺀 창</div><div class="panel"><table><tr><th>요금제</th><th>사유별 창 수</th></tr>${excl}</table>
    <p class="note">제외 기준은 값을 보기 전에 정한 규칙만 씁니다(외부 사용 의심·요금제 변경·비표준 토큰·중복 수집·게이지 상승 5%p 미만).</p></div>
  <div class="tab">참여 로그</div><div class="panel"><div class="feeds"><div><h3>주간 게이지</h3>${feedTable('7d')}</div><div><h3>5시간 게이지</h3>${feedTable('5h')}</div></div>
    <p class="note">한도 창 단위로 갱신됩니다. 새 계정은 ${esc(env.PROBATION_HOURS ?? 24)}시간 검증 후 통계에 반영됩니다.</p></div>
</main>`, { user }), 200, { 'cache-control': 'no-store' });
}

export async function methodology(req, env) {
  const user = await currentUser(req, env);
  return html(layout('방법론 — 클진요', `<section class="band"><div class="wrap"><h1>방법론</h1></div></section><main class="wrap prose">
<h2>무엇을 재나</h2><p>참여자 PC의 수집기(<code>jinsil</code>)가 Claude Code 대화 파일에 남는 <b>사용량 숫자(usage)</b>를 읽고, Claude 사용량 게이지(5시간·주간, %)를 5분마다 조회합니다. 요청 경로에는 끼어들지 않습니다. Anthropic에 직접 간 응답(표준 모델명 + 요청 ID <code>req_</code>)만 셉니다.</p>
<h2>한도 창 계산</h2><p>게이지가 리셋되는 한 주기(5시간 창·주간 창)마다, 첫 게이지 관측을 기준점으로 게이지 최댓값에 처음 닿은 관측까지 쓴 토큰을 API 정가로 환산해 합산합니다(<b>C</b>). 게이지 상승을 <b>Δ</b>라 하면 1%당 값 = C ÷ Δ입니다. 게이지가 1% 단위라 경계 오차를 범위로 함께 냅니다: [C⁻ ÷ (Δ+1), C⁺ ÷ (Δ−1)] (C⁻는 완전히 안쪽 5분 구간만, C⁺는 경계 구간 포함).</p>
<h2>단계</h2><p>계정의 주간 창 누적 상승 기준 +5%p에서 <b>잠정</b>으로 등록하고, 창이 커지면 +8%p <b>보통</b>, +11%p <b>정밀</b>로 자동 갱신합니다. 09-23 팀 계정 로그 모의에서 +5%p는 최종값과 중앙 ±23%, +8%p는 모두 ±20% 안, +11%p는 86%가 ±10% 안이었습니다(주간 창 7개로 표본이 작아 운영 데이터로 재검증 예정).</p>
<h2>주간 100%와 가성비</h2><p>계정별 (Σ비용 ÷ Σ게이지 상승) × 100이 <b>주간 100% 환산액</b>입니다. 요금제별 계정 값의 <b>중앙값</b>(계정당 한 표)에 × 30/7(30일 환산) = 30일 가치, ÷ 월 구독료 = <b>가성비 배수</b>입니다. 매주 100%를 다 썼을 때의 이론적 상한이며 실제 청구액이 아닙니다.</p>
<h2>통계에서 빼는 것</h2><p>값의 크기로는 빼지 않고, 미리 정한 원인만 뺍니다: 로컬 사용 없이 게이지가 오른 창(외부 사용 의심), 창 도중 요금제 변경, fast 모드·서버 도구 등 표준 요금이 아닌 토큰, 캐시 보관 시간 미확인, 두 PC가 똑같은 기록을 낸 창(중복 수집 의심), 게이지 상승 5%p 미만. 계정 사이에서는 요금제 안 분포의 사분위범위 3배 밖 값(측정 오류 방어)과 신규 계정 첫 ${esc(env.PROBATION_HOURS ?? 24)}시간을 뺍니다. 공개는 요금제별 ${esc(env.MIN_ACCOUNTS ?? 5)}계정 이상일 때만, 5시간 지표는 따로 표본 수를 셉니다.</p>
<h2>게이지 가중치는 정가 비율과 다르다</h2><p>09-23 실측에서 같은 계정의 5시간 창 1%당 값이 창마다 ±50~80% 흔들렸고, 캐시 읽기 비중이 높을수록 1%당 값이 올라가고(상관 +0.57) Sonnet 비중이 높을수록 내려갔습니다(−0.47). 게이지가 토큰 종류를 API 정가와 다른 비율로 센다는 뜻이라, 요금제 비교에는 참여자들의 사용 구성이 섞입니다.</p>
<h2>한계</h2><p>참여자가 제출한 값의 진위를 서버가 증명할 방법은 없습니다(참여자 로컬 관측값). 계정 풀·라우터 사용은 기본 집계에서 빠지고, claude.ai 웹·앱 사용은 보이지 않습니다. 단가는 공식 확인 전 잠정값이며, 쓴 단가표는 해시로 남겨 다시 계산할 수 있습니다.</p>
<h2>개인정보</h2><p>프롬프트·응답 본문, 파일 경로, 요청 ID, 호스트명, 이메일, 인증값은 서버로 보내지 않습니다. 서버에는 5분 단위 모델별 토큰 합계, 게이지 값, Claude 계정의 해시 지문, 요금제 등급이 갑니다(5분 단위 시각 포함). 공개 화면에는 지문 끝 4자리만 보입니다. 로그인 토큰은 <code>api.anthropic.com</code>에만 보냅니다.</p></main>`, { user }));
}

export async function link(req, env, user, pending) {
  if (!pending) return html(layout('기기 연결 — 클진요', '<main class="wrap"><div class="panel"><b>연결 코드가 없거나 만료됐습니다.</b> 터미널에서 다시 <code>jinsil login</code>을 실행하세요.</div></main>', { user }), 410);
  const done = pending.approved_user_id || pending.denied;
  return html(layout('기기 연결 — 클진요', `<main class="wrap"><div class="tab">이 PC를 연결할까요?</div><div class="panel">
<p>확인 코드 <b style="font-size:22px">${esc(pending.user_code)}</b> — 터미널에 표시된 코드와 같은지 확인하세요.</p>
<table><tr><th>PC 이름</th><td>${esc(pending.meta.name)}</td></tr><tr><th>OS</th><td>${esc(pending.meta.os)}</td></tr><tr><th>CLI 버전</th><td>${esc(pending.meta.client_version)}</td></tr></table>
${done ? '<p>이미 처리된 코드입니다.</p>' : `<form method="post" style="margin-top:16px;display:flex;gap:10px"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><input type="hidden" name="user_code" value="${esc(pending.user_code)}">
<button class="btn" name="action" value="approve">연결 승인</button><button class="btn ghost" name="action" value="deny">거부</button></form>`}
<p class="note">본인이 방금 터미널에서 실행한 것이 아니면 거부하세요.</p></div></main>`, { user }));
}
export async function linkDone(req, env, ok, approved) {
  return html(layout('기기 연결 — 클진요', `<main class="wrap"><div class="panel"><b>${ok ? (approved ? '연결됐습니다. 터미널로 돌아가세요.' : '거부했습니다.') : '코드가 만료됐거나 이미 처리됐습니다.'}</b></div></main>`), ok ? 200 : 410);
}

function sparkline(points) {
  if (points.length < 2) return '<p class="note">추이를 그리려면 주간 창이 2개 이상 필요합니다.</p>';
  const w = 560, h = 90, vs = points.map(p => p.v), min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1) * (w - 10) + 5).toFixed(1)},${(h - 8 - (p.v - min) / span * (h - 16)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" role="img" aria-label="주간 100% 환산 추이"><polyline fill="none" stroke="#111" stroke-width="3" points="${d}"/></svg>
  <p class="note">주간 창 기준 · 최저 ${usd(min)} · 최고 ${usd(max)} / 100% (${points.length}창)</p>`;
}

const winState = w => w.exclude_reason ? `제외 · ${EXCLUDE_KO[w.exclude_reason] || w.exclude_reason}` : `${STAGE_KO[w.stage]} · ${w.state === 'final' ? '확정' : '진행 중'}`;

export async function me(req, env, user, data) {
  const accounts = data.accounts.length ? data.accounts.map(a => {
    const why = { insufficient_weekly_data: `주간 게이지 누적 +${a.min_weekly_pct}%p부터 등록됩니다(현재 +${a.weekly_pct}%p)`, probation: '신규 계정 검증 기간', flagged: '검토 중', outlier: '같은 요금제 분포에서 크게 벗어나 검토 중', plan_unknown: '요금제 확인 불가(등급 문자열 미확인)' }[a.ineligible] || '';
    const latest = a.latest.map(l => `${gaugeLabel(l.gauge)} ${l.g_end}%`).join(' · ');
    return `<div class="tab">Claude 계정 #${esc(a.tag)} · ${esc(PLAN_LABEL[a.plan] || '요금제 미확인')}${a.stage ? ` · ${STAGE_KO[a.stage]}` : ''}</div><div class="panel">
    <div class="kpis"><div class="kpi"><b>${a.rank ? `${a.rank}위` : '—'}</b><span>${a.rank ? `${esc(PLAN_LABEL[a.plan])} ${a.n_in_plan}명 중 · 상위 ${a.top_pct}%` : esc(why)}</span></div>
    <div class="kpi"><b>${a.value_multiple ? `${a.value_multiple.toFixed(1)}배` : '—'}</b><span>내 가성비 배수</span></div>
    <div class="kpi"><b>${a.effective_usd_per_api_usd ? `${(a.effective_usd_per_api_usd * 100).toFixed(2)}¢` : '—'}</b><span>API 1달러어치를 쓰는 실효 단가</span></div>
    <div class="kpi"><b>${a.usd_per_100pct ? usd(a.usd_per_100pct) : '—'}</b><span>내 주간 100% 환산${a.usd_per_100pct ? ` (범위 ${usd(a.range_lo)}~${usd(a.range_hi)})` : ''}${a.vs_plan_median !== null ? ` · 요금제 중앙값 대비 ${a.vs_plan_median >= 0 ? '+' : ''}${(a.vs_plan_median * 100).toFixed(0)}%` : ''}</span></div></div>
    <p class="note">최근 게이지: ${esc(latest || '—')} · 근거 주간 게이지 +${a.weekly_pct}%p (${a.windows}창)</p></div>`;
  }).join('') : '<div class="panel"><b>아직 제출된 데이터가 없습니다.</b> 터미널에서 <code>npx jinsil setup</code> 후 평소처럼 Claude Code를 쓰면 한도 창 단위로 자동 집계됩니다.</div>';
  const weekly = data.windows.filter(w => w.gauge === '7d' && !w.exclude_reason && w.usd_per_pct !== null).slice().reverse();
  const series = weekly.map(w => ({ v: w.usd_per_pct * 100 }));
  const winTable = gauge => {
    const rs = data.windows.filter(w => w.gauge === gauge).slice(0, 40);
    return `<table><tr><th>창 리셋(KST)</th><th>계정</th><th>게이지</th><th>1%당(범위)</th><th>상태</th></tr>${rs.length ? rs.map(w => `<tr><td>${kst(w.resets_at)}</td><td>#${esc(w.public_tag)}</td><td>${w.g_base}%→${w.g_end}%</td>
    <td class="num">${w.usd_per_pct === null ? '—' : `${usd(w.usd_per_pct, 2)} (${usd(w.usd_per_pct_lo, 2)}~${usd(w.usd_per_pct_hi, 2)})`}</td><td>${esc(winState(w))}</td></tr>`).join('') : '<tr><td colspan="5" class="note">없음</td></tr>'}</table>`;
  };
  const devs = data.devices.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(d.os)}${d.collector ? ` · ${d.collector === 'proxy' ? '프록시' : '대화 파일'}` : ''}</td><td>${d.last_seen ? kst(new Date(d.last_seen).toISOString()) : '—'}</td>
    <td>${d.revoked_at ? '해제됨' : `<form method="post" action="/me/devices/revoke"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><input type="hidden" name="device_id" value="${esc(d.id)}"><button class="btn ghost">연결 해제</button></form>`}</td></tr>`).join('');
  return html(layout('내 대시보드 — 클진요', `<main class="wrap"><div class="lead"><h2>내 대시보드</h2><p>얼마나 비싸게 쓰고 있는지 · 같은 요금제에서 몇 위인지</p></div>
${accounts}
<div class="tab">주간 100% 환산 추이</div><div class="panel">${sparkline(series)}</div>
<div class="tab">한도 창</div><div class="panel"><div class="feeds"><div><h3>주간</h3>${winTable('7d')}</div><div><h3>5시간</h3>${winTable('5h')}</div></div>
<p class="note">창이 커질수록 범위가 좁아지고 단계가 올라갑니다(+5%p 잠정 → +8%p 보통 → +11%p 정밀).</p>
<p class="noprint" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="/me/export.csv">CSV 내려받기</a><a class="btn ghost" href="/me/report">이의제기용 리포트(PDF로 저장)</a></p></div>
<div class="tab">연결된 PC</div><div class="panel"><table><tr><th>이름</th><th>OS · 수집 방식</th><th>마지막 제출</th><th></th></tr>${devs || '<tr><td colspan="4" class="note">없음</td></tr>'}</table></div>
<div class="panel noprint"><form method="post" action="/me/delete" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input type="hidden" name="csrf" value="${esc(user.csrf)}">
<b>내 데이터 전체 삭제</b><input name="confirm" placeholder="DELETE 입력" style="padding:8px;border:2px solid #111"><button class="btn dark">삭제</button><span class="note">공개 통계·순위에서도 빠집니다. 로컬 기록은 PC에서 <code>jinsil uninstall --purge</code>.</span></form>
<form method="post" action="/auth/logout" style="margin-top:10px"><button class="btn ghost">로그아웃</button></form></div></main>`, { user }), 200, { 'cache-control': 'no-store' });
}

export function exportCsv(data) {
  const head = ['account_tag', 'gauge', 'resets_at', 'g_base', 'g_end', 'delta', 't_base', 't_end', 'cost_usd', 'cost_lo', 'cost_hi', 'usd_per_pct', 'usd_per_pct_lo', 'usd_per_pct_hi', 'stage', 'state', 'exclude_reason', 'price_version', 'calc_version'];
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const iso = ms => (ms ? new Date(ms).toISOString() : '');
  const rows = data.windows.map(w => [w.public_tag, w.gauge, w.resets_at, w.g_base, w.g_end, w.delta, iso(w.t_base), iso(w.t_end), w.cost, w.cost_lo, w.cost_hi, w.usd_per_pct, w.usd_per_pct_lo, w.usd_per_pct_hi, w.stage, w.state, w.exclude_reason, w.price_version, w.calc_version].map(q).join(','));
  return new Response('﻿' + [head.join(','), ...rows].join('\n') + '\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="jinsil-my-windows.csv"', 'cache-control': 'no-store' } });
}

// 이의제기용 개인 리포트: 인쇄 CSS로 브라우저 'PDF로 저장'을 쓴다(Workers에서 한글 PDF 직접 생성은 하지 않음).
export async function report(req, env, data) {
  const acc = data.accounts.map(a => `<tr><td>#${esc(a.tag)}</td><td>${esc(PLAN_LABEL[a.plan] || '미확인')}</td><td>+${a.weekly_pct}%p · ${STAGE_KO[a.stage] || '—'}</td><td>${usd(a.usd_per_100pct)} (${usd(a.range_lo)}~${usd(a.range_hi)})</td><td>${a.value_multiple ? a.value_multiple.toFixed(1) + '배' : '—'}</td><td>${a.rank ? `${a.rank}/${a.n_in_plan}` : '—'}</td></tr>`).join('');
  const plans = Object.values(data.plans).map(p => `<tr><td>${esc(p.label)}</td><td>${p.n}</td><td>${p.shown ? `${usd(p.median_usd_per_100pct)} (${usd(p.range_lo)}~${usd(p.range_hi)})` : '측정 대기'}</td><td>${p.shown ? x(p.value_multiple) : '—'}</td></tr>`).join('');
  const rows = data.windows.filter(w => !w.exclude_reason && w.usd_per_pct !== null).map(w => `<tr><td>${esc(w.resets_at)}</td><td>${gaugeLabel(w.gauge)}</td><td>${w.g_base}→${w.g_end}%</td><td>${usd(w.cost, 2)}</td><td>${usd(w.usd_per_pct, 2)} (${usd(w.usd_per_pct_lo, 2)}~${usd(w.usd_per_pct_hi, 2)})</td><td>${esc(w.price_version || '')}</td></tr>`).join('');
  return html(layout('이의제기용 리포트 — 클진요', `<main class="wrap"><div class="lead"><h2>Claude 구독 한도 실측 리포트</h2><p>생성 ${esc(new Date().toISOString())} · <span class="noprint">브라우저 인쇄(⌘P / Ctrl+P) → PDF로 저장</span></p></div>
<div class="panel"><b>측정 방법</b><p class="note">참여자 PC의 수집기(jinsil)가 Claude Code 대화 파일의 사용량 숫자와 5분 간격 게이지 관측으로 한도 창(5시간·주간)마다 쓴 토큰을 API 정가(잠정)로 환산했습니다. 게이지가 1% 단위라 범위를 함께 적었습니다. 참여자 로컬 관측값이며 매주 100%를 다 썼을 때의 이론적 상한 비교이고 실제 청구액이 아닙니다. 가격 버전은 계산에 쓴 단가표의 해시입니다.</p></div>
<div class="tab">내 계정</div><div class="panel"><table><tr><th>계정</th><th>요금제</th><th>근거</th><th>주간 100% 환산(범위)</th><th>가성비</th><th>순위</th></tr>${acc}</table></div>
<div class="tab">요금제 중앙값(전체 참여자)</div><div class="panel"><table><tr><th>요금제</th><th>계정 수</th><th>주간 100% 중앙값(범위)</th><th>가성비</th></tr>${plans}</table></div>
<div class="tab">집계에 쓴 한도 창</div><div class="panel"><table><tr><th>창 리셋(UTC)</th><th>게이지</th><th>변화</th><th>환산 비용</th><th>1%당(범위)</th><th>가격 버전</th></tr>${rows || '<tr><td colspan="6">없음</td></tr>'}</table></div></main>`), 200, { 'cache-control': 'no-store' });
}

export const notFound = () => layout('없는 페이지 — 클진요', '<main class="wrap"><div class="panel"><b>페이지를 찾을 수 없습니다.</b> <a href="/">처음으로</a></div></main>');
