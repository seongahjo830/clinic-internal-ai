// 서울사계절치과 내부 AI — app.js
import { Sync, SETUP_SQL } from './sync.js';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem('ck_' + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem('ck_' + k, JSON.stringify(v)),
};

const state = {
  baseDocs: [],
  uploads: LS.get('uploads', []),
  eduLog: LS.get('edu', []),
  mode: (m => (m === 'dentist' ? 'all' : m === 'staff' ? 'assistant' : m))(LS.get('mode', 'assistant')),
  apiKey: LS.get('apikey', ''),
  model: LS.get('model', 'claude-haiku-4-5'),
  clinic: LS.get('clinic', '서울사계절치과'),
};

// ---------- KB ----------
async function loadKB() {
  try {
    const r = await fetch('kb.json', { cache: 'no-cache' });
    const j = await r.json();
    state.baseDocs = j.docs || [];
  } catch (e) {
    console.error('kb.json 로드 실패', e);
    state.baseDocs = [];
  }
}
const allDocs = () => [...state.baseDocs, ...state.uploads];
// 현재 모드에서 볼 수 있는 문서
//  - 알바·어시(assistant): role==='assistant' 문서만 (경영/HR/임상판단은 숨김)
//  - 원장·실장(all): 전부
const visibleDocs = () =>
  state.mode === 'all' ? allDocs() : allDocs().filter(d => (d.role || 'assistant') === 'assistant');

// ---------- 검색/검색 점수 ----------
function tokenize(q) {
  return (q || '').toLowerCase().split(/[\s,.;:!?()[\]'"~/]+/).filter(t => t.length >= 2);
}
function scoreDoc(doc, tokens) {
  const title = (doc.title || '').toLowerCase();
  const sum = (doc.summary || '').toLowerCase();
  const body = (doc.markdown || '').toLowerCase();
  let s = 0;
  for (const t of tokens) {
    if (title.includes(t)) s += 8;
    if (sum.includes(t)) s += 4;
    const m = body.split(t).length - 1;
    s += Math.min(m, 6);
  }
  return s;
}
function retrieve(query, n = 5) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  return visibleDocs()
    .map(d => ({ d, s: scoreDoc(d, tokens) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(x => x.d);
}
// 검색 모드용: 질문어가 가장 많이 나오는 "섹션"을 뽑아 보여줌 (제목/서두가 아니라 알맹이)
function excerpt(doc, query) {
  const md = (doc.markdown || '');
  const toks = tokenize(query);
  const secs = md.split(/\n(?=#{1,3}\s)/).filter(s => s.trim().length > 30);
  let best = null, bestScore = -1;
  for (const sec of secs) {
    const low = sec.toLowerCase();
    let sc = 0; for (const t of toks) sc += low.split(t).length - 1;
    if (sc > bestScore) { bestScore = sc; best = sec; }
  }
  if (bestScore <= 0) return doc.summary || md.slice(0, 700);
  return best.trim().slice(0, 1900);
}

// ---------- Markdown 렌더 (Obsidian callout + wikilink) ----------
const CALLOUT = {
  summary: '📌', info: 'ℹ️', note: '📝', tip: '💡', example: '🔎', check: '✅',
  success: '✅', warning: '⚠️', caution: '⚠️', danger: '🚫', history: '🕘',
  question: '❓', important: '⭐', todo: '☑️', abstract: '📄', quote: '💬',
};
// 링크 키 정규화: 공백·하이픈·가운뎃점·기호·이모지 제거 → 매칭 견고하게
function normKey(s) {
  return (s || '').toLowerCase().replace(/\.md$/, '')
    .replace(/[\s\-·_().,!?:;#*`~/[\]|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '');
}
function resolveDoc(key) {
  const nk = normKey(key); if (nk.length < 2) return null;
  const docs = allDocs();
  let d = docs.find(x => normKey(x.title) === nk); if (d) return d;
  d = docs.find(x => normKey((x.source || '').split('/').pop()) === nk); if (d) return d;
  d = docs.find(x => { const nt = normKey(x.title); return nt.length >= 2 && (nt.includes(nk) || (nk.length >= 3 && nk.includes(nt))); }); if (d) return d;
  d = docs.find(x => normKey(x.source || '').includes(nk));
  return d || null;
}
function preWikilink(md) {
  return md
    .replace(/!\[\[[^\]]*\]\]/g, '') // 임베드 제거
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, tgt, alias) => {
      const label = (alias || tgt).trim();
      const d = resolveDoc(tgt.split('/').pop().trim());
      // 연결 대상이 있으면 클릭 링크, 없으면 그냥 글자(깨진 "못 찾음" 방지)
      return d ? `<span class="wlink" data-doc="${d.id}">${escapeHtml(label)}</span>` : escapeHtml(label);
    });
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
marked.setOptions({ gfm: true, breaks: true });
const mdToHtml = s => marked.parse(s || '');

function renderMarkdown(rawMd) {
  const md = preWikilink((rawMd || '').replace(/\r/g, ''));
  const lines = md.split('\n');
  let html = '', buf = [];
  const flush = () => { if (buf.length) { html += mdToHtml(buf.join('\n')); buf = []; } };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^>\s*\[!(\w+)\][+-]?\s*(.*)$/);
    if (m) {
      flush();
      const type = m[1].toLowerCase();
      const title = m[2] || '';
      const inner = [];
      i++;
      while (i < lines.length && /^>/.test(lines[i])) { inner.push(lines[i].replace(/^>\s?/, '')); i++; }
      i--;
      const icon = CALLOUT[type] || '📋';
      const titleHtml = title ? mdToHtml(title).replace(/<\/?p>/g, '') : type;
      html += `<div class="callout ${type}"><div class="ct">${icon} ${titleHtml}</div>${mdToHtml(inner.join('\n'))}</div>`;
    } else buf.push(lines[i]);
  }
  flush();
  return DOMPurify.sanitize(html, { ADD_ATTR: ['data-link'] });
}

// ---------- 탭/모드 ----------
function setTab(tab) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.panel').forEach(p => p.classList.toggle('on', p.id === 'panel-' + tab));
}
function setMode(mode) {
  state.mode = mode; LS.set('mode', mode);
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  // 자료추가는 원장·실장(all) 모드에서만
  $('#tabUpload').style.display = mode === 'all' ? '' : 'none';
  if (mode !== 'all' && $('#panel-upload').classList.contains('on')) setTab('chat');
  renderExamples(); renderWiki(); updateKbPill(); renderOnboard();
}
function updateKbPill() {
  const pill = $('#kbPill');
  pill.textContent = `📚 자료 ${visibleDocs().length}개` + (state.apiKey ? ' · 🤖 AI ON' : ' · 🔎 검색 모드 (눌러서 AI 켜기)');
  pill.style.cursor = state.apiKey ? 'default' : 'pointer';
}

// ---------- 예시 질문 ----------
const EX_ASSIST = [
  '신환 오면 뭐부터 준비해요?',
  '레진 할 때 체어 뭐 세팅해요?',
  '대기 30분 넘으면 어떻게 해요?',
  '"왜 이렇게 비싸요" 하면 뭐라고 답해요?',
  '임플란트 가격 얼마예요?',
  '진료 끝나고 다음 예약 며칠 뒤로 잡아요?',
];
const EX_MGR = ['신규 입사자 온보딩 순서는?', '차팅 누락 방지 어떻게 해요?', '원장 지정 진료 응대 표준은?'];
function renderExamples() {
  if ($('#chatLog').children.length) { $('#examplesWrap').innerHTML = ''; return; }
  const list = state.mode === 'all' ? [...EX_ASSIST.slice(0, 3), ...EX_MGR] : EX_ASSIST;
  $('#examplesWrap').innerHTML =
    `<div class="examples">${list.map(q => `<button class="ex-chip">${escapeHtml(q)}</button>`).join('')}</div>`;
  $$('#examplesWrap .ex-chip').forEach(c => c.onclick = () => { $('#qInput').value = c.textContent; ask(); });
}

// ---------- 채팅 ----------
function addMsg(role, html) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.innerHTML = html;
  $('#chatLog').appendChild(div);
  $('#chatCtrl').style.display = 'block';
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}
function resetChat() {
  $('#chatLog').innerHTML = '';
  $('#chatCtrl').style.display = 'none';
  $('#qInput').value = ''; autosize(); $('#sendBtn').disabled = true;
  renderExamples();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function sourcesHtml(docs) {
  if (!docs.length) return '';
  return `<div class="sources"><div class="lbl">📎 근거 자료</div>${docs.map(d =>
    `<span class="src-chip" data-doc="${d.id}">📄 ${escapeHtml(d.title)}</span>`).join('')}</div>`;
}
function bindSourceChips(el) {
  $$('.src-chip', el).forEach(c => c.onclick = () => openDoc(c.dataset.doc));
}

const SYSTEM = clinic => `너는 "${clinic}"에서 일하는 치과 알바·어시스트·데스크 직원을 돕는 내부 AI 선배다.
질문자는 보통 경력이 짧은 직원이다. "어시스트 어떻게 해요 / 이거 할 때 뭐 준비해요 / 환자한테 뭐라고 말해요 / 가격 얼마예요 / 우리치과는 어떻게 돼 있어요" 같은 실무 질문에 답한다.
규칙:
1. 아래 "우리치과 자료 발췌"에 있는 내용만 근거로 답한다. 발췌에 없는 사실(특히 가격·수치)은 지어내지 말 것.
2. 모르면 "이건 등록된 자료에 없어요. 실장님께 확인하거나, 실장님이 자료를 추가하면 답해드릴 수 있어요."라고 말한다.
3. 후배에게 알려주듯 친절하고 아주 구체적으로. 준비물·순서는 번호나 체크리스트로. 환자에게 할 말이 있으면 따옴표로 멘트를 그대로 제시. 한국어.
4. 환자 응대 멘트는 절대 원장·치과의사의 실력을 의심하게 만들지 말 것. 표준화·전문성·근거 프레임으로 안내한다.
5. 답변 끝에 참고한 자료 제목을 언급한다. 의료법·환자안전 관련은 자료 기준을 정확히 전달한다.
6. "이런 상황엔 어떻게 해요?" 같은 돌발/상황 질문이면: ① 상황을 한 줄로 정리 → ② 지금 당장 할 행동을 1·2·3 단계로 → ③ 환자에게 할 말(있으면) → ④ "이건 꼭 실장님/원장님께"로 넘길 선을 분명히. 자료에 없는 의학적 판단은 지어내지 말고 "원장님 확인이 필요해요"로 안전하게 안내.`;

function contextText(docs) {
  // 가장 관련 높은 1~2개는 거의 전문, 나머지는 핵심만 — 답변이 구체적으로 나오게
  return '\n\n# 우리치과 자료 발췌 (이 내용만 근거로 답하세요)\n' + docs.map((d, i) => {
    const limit = i === 0 ? 5000 : i === 1 ? 3500 : 1600;
    return `\n## [자료 ${i + 1}] ${d.title} (${d.category})\n${(d.markdown || '').slice(0, limit)}`;
  }).join('\n');
}

async function callClaude(question, docs) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: state.model,
      max_tokens: 1500,
      system: SYSTEM(state.clinic) + contextText(docs),
      messages: [{ role: 'user', content: question }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).map(c => c.text || '').join('');
}

let busy = false;
async function ask() {
  const q = $('#qInput').value.trim();
  if (!q || busy) return;
  busy = true;
  $('#qInput').value = ''; autosize(); $('#sendBtn').disabled = true;
  $('#examplesWrap').innerHTML = '';
  addMsg('user', escapeHtml(q));
  const docs = retrieve(q, 5);
  const thinking = addMsg('ai', `<span class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span> 자료를 찾는 중…</span>`);

  try {
    if (state.apiKey) {
      const answer = await callClaude(q, docs);
      thinking.innerHTML = `<div class="md">${renderMarkdown(answer)}</div>${sourcesHtml(docs)}`;
    } else {
      // 폴백: 키워드 검색 결과 제시
      if (!docs.length) {
        thinking.innerHTML = `관련 자료를 찾지 못했어요. 다른 키워드로 물어보거나, ⚙️ 설정에서 API 키를 넣으면 AI가 직접 답해드려요.`;
      } else {
        const top = docs[0];
        thinking.innerHTML =
          `<div class="md"><b>🔎 검색 모드</b> — AI 답변을 켜려면 위 <b>📚 자료…</b> 줄(또는 ⚙️)에서 Claude API 키를 넣어주세요. 지금은 가장 관련 있는 자료를 그대로 보여드려요:</div>` +
          `<div class="md card" style="margin-top:10px;padding:16px">${renderMarkdown(excerpt(top, q))}</div>` +
          sourcesHtml(docs);
        bindWikilinks(thinking);
      }
    }
  } catch (e) {
    thinking.innerHTML = `⚠️ AI 호출 실패: ${escapeHtml(e.message)}<br><br>① API 키가 맞는지 ② 결제(크레딧)가 있는지 확인해 주세요. 그래도 아래 자료는 참고할 수 있어요.${sourcesHtml(docs)}`;
  }
  bindSourceChips(thinking);
  bindWikilinks(thinking);
  busy = false; $('#sendBtn').disabled = !$('#qInput').value.trim();
  updateKbPill();
}

// ---------- 위키 (핵심 + 전체 한 탭에) ----------
let wikiView = 'core'; // 'core'(실전 핵심만) | 'all'(전체 목록)
const li = arr => (arr || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
function coreCard(d) {
  return `<div class="core-card" data-doc="${d.id}">
    <div class="cc-h"><span>${escapeHtml(d.title)}</span><span class="cc-go">자세히 →</span></div>
    ${d.core?.length ? `<div class="cc-sec ccore"><div class="cc-l">🎯 이것만은 꼭</div><ul>${li(d.core)}</ul></div>` : ''}
    ${d.risk?.length ? `<div class="cc-sec crisk"><div class="cc-l">⚠️ 빠뜨리면 위험</div><ul>${li(d.risk)}</ul></div>` : ''}
    ${d.say?.length ? `<div class="cc-sec csay"><div class="cc-l">💬 환자에게</div><ul>${li(d.say)}</ul></div>` : ''}
  </div>`;
}
function renderWiki(filter = '') {
  $('#reader').style.display = 'none';
  $('#wikiList').style.display = '';
  const docs = visibleDocs();
  const f = (filter || '').trim().toLowerCase();
  const shown = f ? docs.filter(d => (d.title + d.summary + d.markdown).toLowerCase().includes(f)) : docs;
  const chips = `<div class="wiki-views">
    <button class="vchip ${wikiView === 'core' ? 'on' : ''}" data-v="core">⭐ 실전 핵심만</button>
    <button class="vchip ${wikiView === 'all' ? 'on' : ''}" data-v="all">📚 전체 목록</button></div>`;

  let body;
  if (wikiView === 'core') {
    const cards = shown.filter(d => d.core?.length || d.risk?.length || d.say?.length);
    body = cards.length
      ? `<div class="core-intro">못 읽을 시간 없을 땐 이 카드만. 실전에 바로 쓰는 핵심·실수주의·환자멘트예요. (자세한 건 카드 클릭)</div>` + cards.map(coreCard).join('')
      : `<div class="empty">${f ? '검색 결과가 없어요.' : '아직 정리된 핵심 카드가 없어요. 📚 전체 목록에서 보세요.'}</div>`;
  } else {
    const groups = {};
    for (const d of shown) (groups[d.category] ||= []).push(d);
    const cats = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ko'));
    body = shown.length ? cats.map((cat, gi) => `
      <div class="cat-group ${f || gi === 0 ? 'open' : ''}">
        <div class="cat-head"><span class="arw">▶</span>${escapeHtml(cat)}<span class="cnt">${groups[cat].length}</span></div>
        <div class="doc-list">${groups[cat].map(d => `
          <div class="doc-item" data-doc="${d.id}">
            <div style="flex:1">
              <div class="ti">${escapeHtml(d.title)}</div>
              <div class="sm">${escapeHtml(d.core?.[0] ? '🎯 ' + d.core[0] : (d.summary || ''))}</div>
            </div>
            ${d.refined ? '<span class="badge refined">📘 정리됨</span>' : ''}
            ${d.role === 'dentist' ? '<span class="badge dent">치과의사</span>' : d.role === 'manager' ? '<span class="badge mgr">실장·경영</span>' : ''}
            ${d.uploaded ? '<span class="badge up">추가</span>' : ''}
          </div>`).join('')}</div>
      </div>`).join('') : `<div class="empty">검색 결과가 없어요.</div>`;
  }
  $('#wikiGroups').innerHTML = chips + body;
  $$('.vchip').forEach(b => b.onclick = () => { wikiView = b.dataset.v; renderWiki($('#wikiSearch').value); });
  $$('.cat-head').forEach(h => h.onclick = () => h.parentElement.classList.toggle('open'));
  $$('.doc-item, .core-card').forEach(it => it.onclick = () => openDoc(it.dataset.doc));
}
function openDoc(id) {
  const d = allDocs().find(x => x.id === id);
  if (!d) return;
  setTab('wiki');
  $('#wikiList').style.display = 'none';
  $('#reader').style.display = 'block';
  $('#readerTitle').textContent = d.title;
  $('#readerMeta').innerHTML =
    `<span>📂 ${escapeHtml(d.category)}</span>` +
    (d.role === 'dentist' ? '<span>🦷 치과의사용</span>' : d.role === 'manager' ? '<span>👔 원장·실장용</span>' : '<span>🧑‍🔧 알바·어시</span>') +
    (d.source ? `<span>📄 ${escapeHtml(d.source)}</span>` : '');
  $('#readerBody').innerHTML = renderMarkdown(d.markdown);
  bindWikilinks($('#readerBody'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function bindWikilinks(el) {
  $$('.wlink', el).forEach(w => w.onclick = () => { if (w.dataset.doc) openDoc(w.dataset.doc); });
}

// ---------- 업로드 ----------
function saveUploads() { LS.set('uploads', state.uploads); }
function addUpload(title, text) {
  if (!text.trim()) return;
  state.uploads.push({
    id: 'up-' + Date.now() + '-' + Math.floor(performance.now()),
    title: title.replace(/\.(md|txt|json|csv|markdown)$/i, ''),
    category: '➕ 추가 자료',
    role: 'assistant',
    summary: text.replace(/[#>*`|\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160),
    source: '업로드: ' + title,
    markdown: text,
    uploaded: true,
    ts: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });
  saveUploads();
  state.eduLog.unshift({ text: `자료 추가: ${title}`, dt: new Date().toISOString().slice(0, 16).replace('T', ' ') });
  LS.set('edu', state.eduLog);
  renderUploads(); renderEdu(); renderWiki(); updateKbPill();
  pushShared();
  toast('✅ 자료를 추가했어요');
}
function renderUploads() {
  $('#upCount').textContent = state.uploads.length ? `(${state.uploads.length}개)` : '';
  $('#upList').innerHTML = state.uploads.length
    ? state.uploads.map(u => `
      <div class="up-item" data-id="${u.id}">
        <div style="flex:1"><div class="ti">${escapeHtml(u.title)}</div>
        <div class="meta">${escapeHtml(u.ts || '')} · ${u.markdown.length}자</div></div>
        <button class="btn sm ghost open-up">보기</button>
        <button class="btn sm ghost del-up" style="color:var(--red)">삭제</button>
      </div>`).join('')
    : `<div class="empty">아직 추가한 자료가 없어요. 위에서 파일을 끌어다 놓거나 붙여넣어 보세요.</div>`;
  $$('.open-up').forEach(b => b.onclick = () => openDoc(b.closest('.up-item').dataset.id));
  $$('.del-up').forEach(b => b.onclick = () => {
    const id = b.closest('.up-item').dataset.id;
    state.uploads = state.uploads.filter(u => u.id !== id);
    saveUploads(); pushShared(); renderUploads(); renderWiki(); updateKbPill(); toast('삭제했어요');
  });
}
function renderEdu() {
  $('#eduList').innerHTML = state.eduLog.length
    ? state.eduLog.map((e, i) => `
      <div class="edu-item"><span class="dt">${escapeHtml(e.dt)}</span><span style="flex:1">${escapeHtml(e.text)}</span>
      <button class="btn sm ghost del-edu" data-i="${i}" style="color:var(--red)">×</button></div>`).join('')
    : `<div class="empty">교육 기록이 없어요. 무엇을 교육했는지 적어두면 누적돼요.</div>`;
  $$('.del-edu').forEach(b => b.onclick = () => {
    state.eduLog.splice(+b.dataset.i, 1); LS.set('edu', state.eduLog); pushShared(); renderEdu();
  });
}
function readFiles(files) {
  [...files].forEach(f => {
    const r = new FileReader();
    r.onload = () => addUpload(f.name, String(r.result || ''));
    r.readAsText(f);
  });
}

// ---------- 실시간 공유 동기화 (Supabase) ----------
let syncTimer = null, lastSharedJson = '';
const sharedPayload = () => ({ uploads: state.uploads, edu: state.eduLog });
async function pushShared() {
  if (!Sync.enabled()) return;
  try { const p = sharedPayload(); lastSharedJson = JSON.stringify(p); await Sync.save(p); }
  catch (e) { console.warn('공유 저장 실패', e); toast('⚠️ 공유 저장 실패 — 네트워크 확인'); }
}
async function pullShared(initial) {
  if (!Sync.enabled()) return;
  try {
    const d = await Sync.load(); if (!d) return;
    const j = JSON.stringify({ uploads: d.uploads || [], edu: d.edu || [] });
    if (j === lastSharedJson) return;
    lastSharedJson = j;
    state.uploads = d.uploads || []; state.eduLog = d.edu || [];
    LS.set('uploads', state.uploads); LS.set('edu', state.eduLog);
    renderUploads(); renderEdu(); renderWiki(); renderOnboard(); updateKbPill();
    if (!initial) toast('🔄 공유 자료가 업데이트됐어요');
  } catch (e) { console.warn('공유 불러오기 실패', e); }
}
function startSync() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (!Sync.enabled()) return;
  pullShared(true);
  syncTimer = setInterval(() => pullShared(false), 8000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pullShared(false); });

// ---------- 온보딩 커리큘럼 (신입 알바 자가 적응) ----------
const CURRICULUM = [
  { week: '1주차 · 첫 출근과 기본', steps: [
    { id: 'w1d1', t: 'Day 1 — 우리치과 파악하기', read: ['데스크 개인', '기본정보', '직원 호칭', '호칭'],
      q: ['우리치과는 어떤 곳이에요? 주로 어떤 진료를 해요?', '출근하면 제일 먼저 뭘 해요?', '직원들 호칭은 어떻게 불러요?'] },
    { id: 'w1d2', t: 'Day 2 — 접수·예약·수납', read: ['접수', '예약', '수납'],
      q: ['신환(처음 온 환자) 접수는 어떻게 해요?', '다음 예약은 보통 며칠 뒤로 잡아요?', '수납할 때 실수하면 안 되는 게 뭐예요?'] },
    { id: 'w1d3', t: 'Day 3 — 대기실·소모품 관리', read: ['대기실', '소모품'],
      q: ['아침에 대기실 세팅은 뭐 해요?', '소모품이 떨어지면 어떻게 해요?'] },
  ]},
  { week: '2주차 · 환자 응대', steps: [
    { id: 'w2d1', t: '오래 기다린 / 화난 환자', read: ['대기시간 30분', '대기시간', '욕설', '폭언'],
      q: ['환자가 오래 기다려서 화났어요. 어떻게 응대해요?', '환자가 욕을 하면 어떻게 해요?'] },
    { id: 'w2d2', t: '"왜 이렇게 비싸요" 가격 응대', read: ['가격저항', '비싸'],
      q: ['환자가 "왜 이렇게 비싸요" 하면 뭐라고 답해요?', '비급여 가격을 물어보면 어떻게 안내해요?'] },
    { id: 'w2d3', t: '원장 지정 / 진료 후 안내', read: ['원장 지정', '진료별 주의사항', '안내문'],
      q: ['환자가 원장님을 지정했는데 다른 선생님이 봐야 하면 어떻게 말해요?', '발치하고 나서 환자한테 주의사항을 뭐라고 안내해요?'] },
  ]},
  { week: '3주차 · 진료 어시스트 기본', steps: [
    { id: 'w3d1', t: '진료 보조 준비물', read: ['레진', '임플란트', '발치', '외과', '덴쳐'],
      q: ['레진 치료할 때 체어에 뭐 세팅해요?', '발치 어시스트 준비물은 뭐예요?', '임플란트 수술 어시는 뭘 챙겨요?'] },
    { id: 'w3d2', t: '환자 유형별 주의 / 리콜', read: ['환자유형', '보라색', '리콜'],
      q: ['특별히 조심해야 하는 환자 유형이 있어요?', '재방문(리콜) 안내는 어떻게 해요?'] },
  ]},
];
const FLAT_STEPS = CURRICULUM.flatMap(w => w.steps);
let currDone = LS.get('curr', {});

function matchDocs(keywords) {
  const out = [];
  for (const d of visibleDocs()) {
    const hay = (d.title + ' ' + (d.summary || '')).toLowerCase();
    if (keywords.some(k => hay.includes(k.toLowerCase())) && !out.includes(d)) out.push(d);
  }
  return out.slice(0, 4);
}
function currProgress() {
  const done = FLAT_STEPS.filter(s => currDone[s.id]).length;
  return { done, total: FLAT_STEPS.length, pct: Math.round(done / FLAT_STEPS.length * 100) };
}
function nextStep() { return FLAT_STEPS.find(s => !currDone[s.id]) || null; }
function toggleStep(id) { currDone[id] = !currDone[id]; LS.set('curr', currDone); renderOnboard(); }
function askFromCurr(q) { setTab('chat'); $('#qInput').value = q; autosize(); $('#sendBtn').disabled = false; ask(); }

function renderOnboard() {
  const root = $('#onboardRoot'); if (!root) return;
  const p = currProgress(), next = nextStep();
  const today = next
    ? `<div class="today"><div class="lbl">🎓 오늘 할 일</div><div class="step-t">${escapeHtml(next.t)}</div>
        <div class="hint">읽을 자료를 보고 → 아래 질문을 눌러 물어보고 → 다 됐으면 체크하세요.</div></div>`
    : `<div class="today doneall"><div class="lbl">🎉 온보딩을 모두 끝냈어요!</div><div class="hint">이제 궁금한 건 언제든 💬 질문하기에서 물어보세요.</div></div>`;
  const bar = `<div class="prog"><div class="prog-bar"><span style="width:${p.pct}%"></span></div><div class="prog-n">${p.done}/${p.total} · ${p.pct}%</div></div>`;
  const weeks = CURRICULUM.map(w => `
    <div class="ob-week"><div class="ob-wk-t">${escapeHtml(w.week)}</div>
      ${w.steps.map(s => {
        const docs = matchDocs(s.read), done = !!currDone[s.id];
        return `<div class="ob-step${done ? ' done' : ''}">
          <label class="ob-head"><input type="checkbox" class="ob-chk" data-id="${s.id}"${done ? ' checked' : ''}><span>${escapeHtml(s.t)}</span></label>
          <div class="ob-line">📖 <span class="ob-lbl">읽기</span> ${docs.length
            ? docs.map(d => `<button class="chip read-chip" data-doc="${d.id}">${escapeHtml(d.title)}</button>`).join('')
            : '<span class="muted">관련 자료는 아래 질문으로 AI에게 물어보세요</span>'}</div>
          <div class="ob-line">💬 <span class="ob-lbl">물어보기</span> ${s.q.map(q => `<button class="chip ask-chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join('')}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
  root.innerHTML = `<div class="ob-hero"><h1>🎓 신입 온보딩 가이드</h1>
    <p>매일 시간 날 때 여기 와서 <b>오늘 할 일</b>을 읽고 질문해 보세요. 3주면 혼자 일할 수 있어요.</p>${bar}</div>${today}${weeks}`;
  $$('#onboardRoot .ob-chk').forEach(c => c.onchange = () => toggleStep(c.dataset.id));
  $$('#onboardRoot .read-chip').forEach(b => b.onclick = () => openDoc(b.dataset.doc));
  $$('#onboardRoot .ask-chip').forEach(b => b.onclick = () => askFromCurr(b.dataset.q));
}

// ---------- 설정 ----------
function openSettings() {
  $('#clinicInput').value = state.clinic;
  $('#apiKeyInput').value = state.apiKey;
  $('#modelSelect').value = state.model;
  const c = Sync.cfg() || {};
  $('#syncUrl').value = c.url || '';
  $('#syncKey').value = c.key || '';
  $('#setupSql').textContent = SETUP_SQL;
  renderSyncStatus();
  updateKeyStatus();
  $('#overlay').classList.add('on');
}
function renderSyncStatus(msg, cls) {
  const el = $('#syncStatus');
  if (msg) { el.textContent = msg; el.className = 'sync-st ' + (cls || ''); return; }
  el.className = 'sync-st ' + (Sync.enabled() ? 'ok' : '');
  el.textContent = Sync.enabled()
    ? '🟢 실시간 공유 켜짐 — 모든 기기에서 같은 자료를 봅니다'
    : '⚪ 꺼짐 — 추가한 자료가 이 기기에만 저장됩니다';
}
async function connectSync() {
  const url = $('#syncUrl').value.trim(), key = $('#syncKey').value.trim();
  if (!url || !key) { renderSyncStatus('주소와 키를 모두 넣어주세요', 'err'); return; }
  renderSyncStatus('연결 확인 중…');
  const r = await Sync.test(url, key);
  if (!r.ok) {
    renderSyncStatus(`연결 실패 (${r.status || '네트워크'}) — 주소·키·SQL 실행을 확인하세요`, 'err');
    return;
  }
  Sync.setCfg(url, key);
  // 이 기기의 기존 추가자료를 공유 저장소에 합쳐 올림 (최초 연결 시)
  const remote = await Sync.load();
  const mergedUp = [...(remote?.uploads || [])];
  for (const u of state.uploads) if (!mergedUp.some(x => x.id === u.id)) mergedUp.push(u);
  const mergedEdu = [...(remote?.edu || []), ...state.eduLog];
  state.uploads = mergedUp; state.eduLog = mergedEdu;
  LS.set('uploads', state.uploads); LS.set('edu', state.eduLog);
  await pushShared();
  renderUploads(); renderEdu(); renderWiki(); renderOnboard(); updateKbPill();
  startSync();
  renderSyncStatus();
  toast('🟢 실시간 공유를 켰어요');
}
function disconnectSync() {
  Sync.clear();
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  renderSyncStatus();
  toast('실시간 공유를 껐어요 (자료는 이 기기에 남아요)');
}
function updateKeyStatus() {
  const el = $('#keyStatus');
  el.className = state.apiKey ? 'keyok' : 'keyno';
  el.textContent = state.apiKey ? '● 연결됨' : '● 미설정 (검색만 가능)';
}
function saveSettings() {
  state.clinic = $('#clinicInput').value.trim() || '서울사계절치과';
  state.apiKey = $('#apiKeyInput').value.trim();
  state.model = $('#modelSelect').value;
  LS.set('clinic', state.clinic); LS.set('apikey', state.apiKey); LS.set('model', state.model);
  $('#clinicName').textContent = state.clinic;
  updateKeyStatus(); updateKbPill();
  $('#overlay').classList.remove('on');
  toast('설정을 저장했어요');
}

// ---------- 유틸 ----------
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}
function autosize() {
  const ta = $('#qInput'); ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

// ---------- 초기화 ----------
async function init() {
  await loadKB();
  $('#clinicName').textContent = state.clinic;
  setMode(state.mode);
  renderUploads(); renderEdu(); renderExamples(); updateKbPill();

  $$('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  $('#settingsBtn').onclick = openSettings;
  $('#kbPill').onclick = () => { if (!state.apiKey) openSettings(); };
  $('#closeSettings').onclick = () => $('#overlay').classList.remove('on');
  $('#saveSettings').onclick = saveSettings;
  $('#overlay').onclick = e => { if (e.target.id === 'overlay') $('#overlay').classList.remove('on'); };

  $('#qInput').oninput = () => { autosize(); $('#sendBtn').disabled = !$('#qInput').value.trim(); };
  $('#qInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };
  $('#sendBtn').onclick = ask;
  $('#resetChat').onclick = resetChat;

  $('#wikiSearch').oninput = e => renderWiki(e.target.value);
  $('#backBtn').onclick = () => renderWiki($('#wikiSearch').value);

  const dz = $('#dropzone');
  dz.onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => readFiles(e.target.files);
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => readFiles(e.dataTransfer.files));
  $('#addPasteBtn').onclick = () => {
    const t = $('#pasteArea').value.trim();
    if (!t) return toast('내용을 입력해 주세요');
    addUpload('붙여넣은 자료 ' + new Date().toLocaleDateString('ko'), t);
    $('#pasteArea').value = '';
  };
  $('#addEduBtn').onclick = () => {
    const t = $('#eduInput').value.trim();
    if (!t) return toast('교육 내용을 입력해 주세요');
    state.eduLog.unshift({ text: t, dt: new Date().toISOString().slice(0, 16).replace('T', ' ') });
    LS.set('edu', state.eduLog); pushShared(); $('#eduInput').value = ''; renderEdu(); toast('교육 기록 추가');
  };

  $('#syncConnect').onclick = connectSync;
  $('#syncDisconnect').onclick = disconnectSync;
  $('#copySql').onclick = () => { navigator.clipboard?.writeText(SETUP_SQL); toast('SQL을 복사했어요'); };

  renderWiki(); renderOnboard();
  startSync();
}
init();
