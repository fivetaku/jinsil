// 웹 페이지 (캠페인형 볼드: 노란 슬로건 띠 + 검정 블록 + 흰 데이터 영역). 데이터 영역에는 선동 문구를 두지 않는다.
import { html, esc, PLAN_LABEL } from './util.js';
import { publicStats, feed } from './stats.js';
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
.bars .row{display:grid;grid-template-columns:90px 1fr 90px;align-items:center;gap:10px;margin:8px 0;font-weight:800}
.bar{height:26px;background:#f2f2f2;position:relative}.bar i{position:absolute;left:0;top:0;bottom:0;background:#111}.bar i.hi{background:#FFD400;border:2px solid #111}
.bar.wait{background:repeating-linear-gradient(45deg,#fff,#fff 6px,#eee 6px,#eee 12px);border:2px dashed #999}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-weight:700;color:#555;border-bottom:2px solid #111;padding:8px 6px}
td{padding:8px 6px;border-bottom:1px solid #eee}td.num{font-variant-numeric:tabular-nums}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#2a9d4a;margin-right:6px}.dot.g{background:#aaa}.dot.r{background:#D62828}
.ranks{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.ranks h3{margin:0 0 8px;font-size:17px}
.foot{text-align:center;color:#666;font-size:13px;margin:40px 0 30px}
.note{font-size:13px;color:#666;margin:10px 0 0}.warn{background:#fff6cc;border:2px solid #111;padding:10px 14px;font-size:14px;margin-top:14px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.kpi{border:2px solid #111;padding:14px}.kpi b{display:block;font-size:30px;font-weight:900;letter-spacing:-1px}.kpi span{font-size:13px;color:#555}
code,pre{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:13px}pre{padding:12px;overflow:auto}
.prose{max-width:780px;line-height:1.75;font-size:16px}.prose h2{margin-top:32px}
@media (max-width:820px){.cards,.ranks,.kpis{grid-template-columns:1fr}.logo small{display:none}.nav a.hide-m{display:none}.big{font-size:48px}
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

function planCard(p, sticks, bestPlan) {
  const s = (sticks[p.plan] || []).map(t => `<span class="st ${t.kind}">${esc(t.text)}</span>`).join('');
  const body = p.shown
    ? `<div class="big">${x(p.value_multiple)}</div><div class="sub">월 최대 ≈ ${usd(p.monthly_value)}</div>
       <div class="meta">주간 100% ≈ ${usd(p.mean_usd_per_100pct)} · 참여 ${p.n}계정</div>`
    : `<div class="big muted">구독료의 ?배</div><div class="meta">공개 기준 ${p.min_accounts}계정 · 현재 ${p.n}계정</div>`;
  return `<div class="card ${bestPlan === p.plan ? 'best' : ''}"><div class="hd">${esc(p.label)}<span>월 ${usd(p.price)}</span></div>
    <div class="bd">${body}<div class="stickers">${s}</div></div></div>`;
}

export async function home(req, env) {
  const [s, f, user] = await Promise.all([publicStats(env), feed(env, 20), currentUser(req, env)]);
  const plans = ['pro', 'max5x', 'max20x'].map(k => s.plans[k]);
  const best = Object.entries(s.stickers).find(([, v]) => v.some(t => t.kind === 'best'))?.[0];
  const maxMult = Math.max(1, ...plans.map(p => p.shown ? p.value_multiple : 0));
  const bars = plans.map(p => p.shown
    ? `<div class="row"><span>${esc(p.label)}</span><div class="bar"><i class="${best === p.plan ? 'hi' : ''}" style="width:${(p.value_multiple / maxMult * 100).toFixed(1)}%"></i></div><span>${x(p.value_multiple)}</span></div>`
    : `<div class="row"><span>${esc(p.label)}</span><div class="bar wait"></div><span style="color:#888">측정 대기</span></div>`).join('');
  const rankTables = plans.map(p => {
    const rows = s.ranking[p.plan];
    return `<div><h3>${esc(p.label)}</h3>${rows.length ? `<table><tr><th>순위</th><th>참여자</th><th>가성비</th><th class="hide-m">주간 100%</th></tr>${rows.slice(0, 10).map(r =>
      `<tr><td>${r.rank}</td><td>#${esc(r.tag)}</td><td class="num">${(r.value_multiple).toFixed(1)}배</td><td class="num hide-m">${usd(r.usd_per_100pct)}</td></tr>`).join('')}</table>`
      : `<p class="note">${p.shown ? '아직 순위에 오른 계정이 없습니다(주간 게이지 3%p 이상 필요).' : `측정 대기 — 이 요금제 참여 계정이 ${p.min_accounts}개 이상이면 순위를 공개합니다(현재 ${p.n}).`}</p>`}</div>`;
  }).join('');
  const feedRows = f.length ? f.map(r => `<tr><td>${kst(r.at)}</td><td><span class="dot ${r.status === 'accepted' ? (r.display === '검증 중' ? 'g' : '') : r.status === 'flagged' ? 'r' : 'g'}"></span>#${esc(r.tag)}</td>
    <td>${esc(PLAN_LABEL[r.plan] || '미확인')}</td><td>${gaugeLabel(r.gauge)} ${esc(r.range)}</td><td class="num">${esc(r.display)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="note">아직 제출된 구간이 없습니다.</td></tr>';
  return html(layout('클진요 — 클로드에게 진실을 요구합니다', `
<section class="band"><div class="wrap"><h1>클로드에게 진실을 요구합니다</h1></div></section>
<main class="wrap" id="stats">
  <div class="lead"><h2>구독료 <mark>1달러로</mark> 얼마나 쓸 수 있나</h2><p>${esc(s.note)}${s.price_status === 'provisional' ? ' · 단가 잠정' : ''}</p></div>
  <div class="cards">${plans.map(p => planCard(p, s.stickers, best)).join('')}</div>
  <div class="tab">가성비 배수</div><div class="panel bars">${bars}
    <p class="note">가성비 배수 = (주간 100% 환산 × 4.35주) ÷ 월 구독료. 계정당 한 표로 평균${s.baseline ? ` · 가격→가치 비교 기준: ${esc(PLAN_LABEL[s.baseline])}` : ''}.</p></div>
  <div class="tab">요금제별 순위</div><div class="panel"><div class="ranks">${rankTables}</div>
    <p class="note">순위가 낮을수록 같은 구독료로 한도를 더 빨리 쓰는 사용 패턴입니다(캐시·출력 비중에 따라 달라짐). 익명 태그만 공개합니다.</p></div>
  <div class="tab">참여 로그</div><div class="panel"><table><tr><th>시각(KST)</th><th>참여자</th><th>요금제</th><th>게이지 변화</th><th>환산</th></tr>${feedRows}</table></div>
  <div class="panel noprint"><b>참여 방법</b> — 터미널에서 <code>npx jinsil setup</code> 한 번이면 끝. 이후 평소처럼 <code>claude</code>로 작업하면 기록·제출이 자동입니다. <a href="/methodology">어떻게 계산하나요?</a></div>
</main>`, { user }), 200, { 'cache-control': 'no-store' });
}

export async function methodology(req, env) {
  const user = await currentUser(req, env);
  return html(layout('방법론 — 클진요', `<section class="band"><div class="wrap"><h1>방법론</h1></div></section><main class="wrap prose">
<h2>무엇을 재나</h2><p>Claude 응답 헤더의 한도 게이지(5시간·주간, 정수 %)가 오르는 동안 실제로 쓴 토큰을 모델·항목별로 모읍니다. 게이지가 k%에서 k+n%로 오른 <b>구간</b>의 토큰을 API 정가로 환산해 1%당 비용을 냅니다.</p>
<h2>주간 100%와 가성비</h2><p>계정별로 수용된 주간 구간의 (비용 합 ÷ 게이지 상승 합) × 100이 그 계정의 <b>주간 100% 환산액</b>입니다. 요금제별로 계정 평균(계정당 한 표)을 내고, × 4.35주 = 월 최대 가치, ÷ 월 구독료(Pro $20 · Max 5x $100 · Max 20x $200, 세금은 공통이라 제외) = <b>가성비 배수</b>입니다.</p>
<p><b>매주 100%를 다 썼을 때의 이론적 상한</b>입니다. 실제로 받는 가치가 아니라 요금제가 허용하는 최대치의 비교입니다. API 정가 환산은 실제 청구액이 아닙니다.</p>
<h2>스티커</h2><p>가성비 1위(공개된 요금제 2개 이상일 때 최댓값), 구독료의 N배, 가격 N배 → 가치 M배(비교 기준: Pro가 5계정을 채우기 전엔 Max 5x, 이후 Pro), 광고보다 적음(가치 배수가 가격 배수의 80% 미만), 측정 대기(5계정 미만).</p>
<h2>순위</h2><p>요금제 안에서 계정별 가성비 배수 순입니다. 주간 게이지 합 3%p 이상, 이상치(사분위범위 3배 밖)·검토 중 계정 제외. 같은 요금제라도 캐시·출력 비중에 따라 값이 달라집니다.</p>
<h2>통계에서 빼는 것</h2><p>기록 누락·중단된 요청, 캐시 보관 시간 미확인, 단가 미확인 모델, 라우터·계정 풀 경유, 요금제 미확인, 5시간 3틱·주간 1틱 미만 구간, 신규 계정 첫 ${esc(env.PROBATION_HOURS ?? 24)}시간. 같은 계정의 구간이 겹치면 거부합니다.</p>
<h2>한계</h2><p>같은 계정을 웹·모바일·다른 PC에서 함께 쓰면 게이지만 오르고 토큰은 기록되지 않아 1%당 비용이 낮게 나옵니다. 참여 중에는 한 기기에서만 쓰는 것이 정확합니다. 참여자 PC의 기록 진위를 서버가 증명할 방법은 없으며, 이상치 제외와 계정당 한 표로 영향을 줄입니다. 단가는 공식 확인 전 잠정값입니다.</p>
<h2>개인정보</h2><p>프롬프트·응답·인증값·이메일은 서버로 보내지 않습니다. Claude 계정은 UUID의 해시 지문으로만 구분하고, 공개 화면에는 지문 끝 4자리만 보입니다. 원본 장부는 참여자 PC의 <code>~/.jinsil</code>에만 남습니다.</p></main>`, { user }));
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
  if (points.length < 2) return '<p class="note">추이를 그리려면 수용된 주간 구간이 2개 이상 필요합니다.</p>';
  const w = 560, h = 90, vs = points.map(p => p.v), min = Math.min(...vs), max = Math.max(...vs), span = max - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1) * (w - 10) + 5).toFixed(1)},${(h - 8 - (p.v - min) / span * (h - 16)).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" width="100%" height="${h}" role="img" aria-label="주간 1%당 비용 추이"><polyline fill="none" stroke="#111" stroke-width="3" points="${d}"/></svg>
  <p class="note">주간 구간 기준 · 최저 ${usd(min, 2)} · 최고 ${usd(max, 2)} / 1% (${points.length}구간)</p>`;
}

export async function me(req, env, user, data) {
  const accounts = data.accounts.length ? data.accounts.map(a => {
    const why = { insufficient_weekly_data: '주간 게이지 3%p 이상 쌓이면 순위에 들어갑니다', probation: '신규 계정 검증 기간', flagged: '검토 중', outlier: '같은 요금제 분포에서 크게 벗어나 검토 중', plan_unknown: '요금제 확인 불가' }[a.ineligible] || '';
    const latest = a.latest.map(l => `${gaugeLabel(l.gauge)} ${l.g_end}%`).join(' · ');
    return `<div class="tab">Claude 계정 #${esc(a.tag)} · ${esc(PLAN_LABEL[a.plan] || '요금제 미확인')}</div><div class="panel">
    <div class="kpis"><div class="kpi"><b>${a.rank ? `${a.rank}위` : '—'}</b><span>${a.rank ? `${esc(PLAN_LABEL[a.plan])} ${a.n_in_plan}명 중 · 상위 ${a.top_pct}%` : esc(why)}</span></div>
    <div class="kpi"><b>${a.value_multiple ? `${a.value_multiple.toFixed(1)}배` : '—'}</b><span>내 가성비 배수</span></div>
    <div class="kpi"><b>${a.effective_usd_per_api_usd ? `${(a.effective_usd_per_api_usd * 100).toFixed(2)}¢` : '—'}</b><span>API 1달러어치를 쓰는 실효 단가</span></div>
    <div class="kpi"><b>${a.usd_per_100pct ? usd(a.usd_per_100pct) : '—'}</b><span>내 주간 100% 환산${a.vs_plan_mean !== null ? ` · 요금제 평균 대비 ${a.vs_plan_mean >= 0 ? '+' : ''}${(a.vs_plan_mean * 100).toFixed(0)}%` : ''}</span></div></div>
    <p class="note">최근 제출 기준 게이지: ${esc(latest || '—')} · 근거 주간 게이지 ${a.weekly_pct}%p</p></div>`;
  }).join('') : '<div class="panel"><b>아직 제출된 구간이 없습니다.</b> 터미널에서 <code>npx jinsil setup</code> 후 평소처럼 <code>claude</code>로 작업하면 게이지가 오른 구간이 자동으로 제출됩니다.</div>';
  // 5시간 1%와 주간 1%는 단위가 달라 섞지 않는다 — 추이는 주간 구간만.
  const accepted = data.intervals.filter(i => i.status === 'accepted' && i.usd_per_pct !== null && i.gauge === '7d').slice().reverse();
  const series = accepted.map(i => ({ v: i.usd_per_pct }));
  const reasonKo = r => ({ too_few_ticks: '게이지 상승 부족', routed_upstream: '라우터 경유', cache_ttl_unknown: '캐시 보관시간 미확인', unpriced_model: '단가 미확인 모델', incomplete_usage: '기록 불완전', tier_unknown: '요금제 미확인', daily_interval_cap: '일일 한도 초과', pending_or_interrupted_requests: '중단된 요청' }[r] || r || '');
  const rows = data.intervals.slice(0, 50).map(i => `<tr><td>${kst(i.t_end)}</td><td>#${esc(i.public_tag)}</td><td>${gaugeLabel(i.gauge)} ${i.g_start}%→${i.g_end}%</td>
    <td class="num">${i.requests}</td><td class="num">${i.usd_per_pct === null ? '—' : usd(i.usd_per_pct, 2)}</td><td>${i.status === 'accepted' ? '수용' : i.status === 'flagged' ? '검토 중' : `제외 · ${esc(reasonKo(i.exclude_reason))}`}</td></tr>`).join('');
  const devs = data.devices.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(d.os)}</td><td>${d.last_seen ? kst(new Date(d.last_seen).toISOString()) : '—'}</td>
    <td>${d.revoked_at ? '해제됨' : `<form method="post" action="/me/devices/revoke"><input type="hidden" name="csrf" value="${esc(user.csrf)}"><input type="hidden" name="device_id" value="${esc(d.id)}"><button class="btn ghost">연결 해제</button></form>`}</td></tr>`).join('');
  return html(layout('내 대시보드 — 클진요', `<main class="wrap"><div class="lead"><h2>내 대시보드</h2><p>얼마나 비싸게 쓰고 있는지 · 같은 요금제에서 몇 위인지</p></div>
${accounts}
<div class="tab">주간 1%당 비용 추이</div><div class="panel">${sparkline(series)}</div>
<div class="tab">제출 이력</div><div class="panel"><table><tr><th>구간 끝(KST)</th><th>계정</th><th>게이지</th><th>요청</th><th>1%당</th><th>상태</th></tr>${rows || '<tr><td colspan="6" class="note">없음</td></tr>'}</table>
<p class="noprint" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn" href="/me/export.csv">CSV 내려받기</a><a class="btn ghost" href="/me/report">이의제기용 리포트(PDF로 저장)</a></p></div>
<div class="tab">연결된 PC</div><div class="panel"><table><tr><th>이름</th><th>OS</th><th>마지막 제출</th><th></th></tr>${devs || '<tr><td colspan="4" class="note">없음</td></tr>'}</table></div>
<div class="panel noprint"><form method="post" action="/me/delete" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input type="hidden" name="csrf" value="${esc(user.csrf)}">
<b>내 데이터 전체 삭제</b><input name="confirm" placeholder="DELETE 입력" style="padding:8px;border:2px solid #111"><button class="btn dark">삭제</button><span class="note">공개 통계·순위에서도 빠집니다. 로컬 기록은 PC에서 <code>jinsil uninstall --purge</code>.</span></form>
<form method="post" action="/auth/logout" style="margin-top:10px"><button class="btn ghost">로그아웃</button></form></div></main>`, { user }), 200, { 'cache-control': 'no-store' });
}

export function exportCsv(data) {
  const head = ['interval_id', 'account_tag', 'gauge', 'g_start', 'g_end', 't_start', 't_end', 'requests', 'cost_usd', 'usd_per_pct', 'status', 'exclude_reason'];
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = data.intervals.map(i => [i.interval_id, i.public_tag, i.gauge, i.g_start, i.g_end, i.t_start, i.t_end, i.requests, i.cost_usd, i.usd_per_pct, i.status, i.exclude_reason].map(q).join(','));
  return new Response('﻿' + [head.join(','), ...rows].join('\n') + '\n', { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="jinsil-my-intervals.csv"', 'cache-control': 'no-store' } });
}

// 이의제기용 개인 리포트: 인쇄 CSS로 브라우저 'PDF로 저장'을 쓴다(Workers에서 한글 PDF 직접 생성은 하지 않음).
export async function report(req, env, data) {
  const acc = data.accounts.map(a => `<tr><td>#${esc(a.tag)}</td><td>${esc(PLAN_LABEL[a.plan] || '미확인')}</td><td>${a.weekly_pct}%p</td><td>${usd(a.usd_per_100pct)}</td><td>${a.value_multiple ? a.value_multiple.toFixed(1) + '배' : '—'}</td><td>${a.rank ? `${a.rank}/${a.n_in_plan}` : '—'}</td></tr>`).join('');
  const plans = Object.values(data.plans).map(p => `<tr><td>${esc(p.label)}</td><td>${p.n}</td><td>${p.shown ? usd(p.mean_usd_per_100pct) : '측정 대기'}</td><td>${p.shown ? x(p.value_multiple) : '—'}</td></tr>`).join('');
  const rows = data.intervals.filter(i => i.status === 'accepted').map(i => `<tr><td>${esc(i.t_start)}</td><td>${esc(i.t_end)}</td><td>${gaugeLabel(i.gauge)}</td><td>${i.g_start}→${i.g_end}%</td><td>${i.requests}</td><td>${usd(i.cost_usd, 2)}</td></tr>`).join('');
  return html(layout('이의제기용 리포트 — 클진요', `<main class="wrap"><div class="lead"><h2>Claude 구독 한도 실측 리포트</h2><p>생성 ${esc(new Date().toISOString())} · <span class="noprint">브라우저 인쇄(⌘P / Ctrl+P) → PDF로 저장</span></p></div>
<div class="panel"><b>측정 방법</b><p class="note">참여자 PC의 로컬 기록기(jinsil)가 응답 헤더의 한도 게이지와 요청별 토큰을 기록하고, 게이지 상승 구간의 토큰을 API 정가(잠정)로 환산했습니다. 원본 요청 기록은 참여자 PC에 있습니다. 매주 100%를 다 썼을 때의 이론적 상한 비교이며 실제 청구액이 아닙니다.</p></div>
<div class="tab">내 계정</div><div class="panel"><table><tr><th>계정</th><th>요금제</th><th>근거 주간 게이지</th><th>주간 100% 환산</th><th>가성비</th><th>순위</th></tr>${acc}</table></div>
<div class="tab">요금제 평균(전체 참여자)</div><div class="panel"><table><tr><th>요금제</th><th>계정 수</th><th>주간 100% 평균</th><th>가성비</th></tr>${plans}</table></div>
<div class="tab">수용된 구간</div><div class="panel"><table><tr><th>시작(UTC)</th><th>끝(UTC)</th><th>게이지</th><th>변화</th><th>요청</th><th>환산 비용</th></tr>${rows || '<tr><td colspan="6">없음</td></tr>'}</table></div></main>`), 200, { 'cache-control': 'no-store' });
}

export const notFound = () => layout('없는 페이지 — 클진요', '<main class="wrap"><div class="panel"><b>페이지를 찾을 수 없습니다.</b> <a href="/">처음으로</a></div></main>');
