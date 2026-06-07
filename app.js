// 서울사계절치과 내부 AI — app.js
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
  mode: LS.get('mode', 'staff'),
  apiKey: LS.get('apikey', ''),
  model: LS.get('model', 'claude-sonnet-4-6'),
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
// 현재 모드에서 볼 수 있는 문서 (직원=both만, 치과의사=전부)
const visibleDocs = () =>
  allDocs().filter(d => state.mode === 'dentist' || d.audience !== 'dentist');

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

// ---------- Markdown 렌더 (Obsidian callout + wikilink) ----------
const CALLOUT = {
  summary: '📌', info: 'ℹ️', note: '📝', tip: '💡', example: '🔎', check: '✅',
  success: '✅', warning: '⚠️', caution: '⚠️', danger: '🚫', history: '🕘',
  question: '❓', important: '⭐', todo: '☑️', abstract: '📄', quote: '💬',
};
function preWikilink(md) {
  return md
    .replace(/!\[\[[^\]]*\]\]/g, '') // 임베드 제거
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, tgt, alias) => {
      const label = (alias || tgt).trim();
      const key = tgt.split('/').pop().trim();
      return `<span class="wlink" data-link="${escapeHtml(key)}">${escapeHtml(label)}</span>`;
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
  // 직원은 자료추가 탭 숨김
  $('#tabUpload').style.display = mode === 'dentist' ? '' : 'none';
  if (mode === 'staff' && $('#panel-upload').classList.contains('on')) setTab('chat');
  renderExamples(); renderWiki(); updateKbPill();
}
function updateKbPill() {
  $('#kbPill').textContent = `📚 자료 ${visibleDocs().length}개` + (state.apiKey ? ' · AI ON' : ' · 검색 모드');
}

// ---------- 예시 질문 ----------
const EX_STAFF = [
  '비급여 단독 진료 차팅 어떻게 해요?',
  '휴가 신청은 어떻게 하나요?',
  '대기시간 30분 넘으면 어떻게 응대해요?',
  '환자가 "왜 이렇게 비싸"라고 하면?',
  '신규 입사자 온보딩 순서는?',
];
const EX_DENT = ['임플란트 2차 수술 루틴은?', '레진 수복 우리치과 SOP는?', '원장 지정 진료 응대 표준은?'];
function renderExamples() {
  if ($('#chatLog').children.length) { $('#examplesWrap').innerHTML = ''; return; }
  const list = state.mode === 'dentist' ? [...EX_STAFF.slice(0, 3), ...EX_DENT] : EX_STAFF;
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
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}
function sourcesHtml(docs) {
  if (!docs.length) return '';
  return `<div class="sources"><div class="lbl">📎 근거 자료</div>${docs.map(d =>
    `<span class="src-chip" data-doc="${d.id}">📄 ${escapeHtml(d.title)}</span>`).join('')}</div>`;
}
function bindSourceChips(el) {
  $$('.src-chip', el).forEach(c => c.onclick = () => openDoc(c.dataset.doc));
}

const SYSTEM = clinic => `너는 "${clinic}"의 내부 규정·운영·임상 안내를 돕는 AI 비서다.
규칙:
1. 아래에 제공된 "우리치과 자료 발췌"에 있는 내용만 근거로 답한다. 발췌에 없는 사실은 지어내지 말 것.
2. 답을 모르면 "이 내용은 등록된 자료에 없어요. 실장님/원장님께 확인하거나 자료를 추가해 주세요."라고 말한다.
3. 후배에게 알려주듯 친절하고 구체적으로, 단계가 있으면 번호로. 한국어로.
4. 답변 끝에 어떤 자료를 참고했는지 자료 제목을 언급한다.
5. 의료법·환자안전 관련은 자료에 적힌 기준을 정확히 전달한다.`;

function contextText(docs) {
  return '\n\n# 우리치과 자료 발췌\n' + docs.map((d, i) =>
    `\n## [자료 ${i + 1}] ${d.title} (${d.category})\n${(d.markdown || '').slice(0, 2200)}`).join('\n');
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
      max_tokens: 1200,
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
          `<div class="md"><b>🔎 검색 모드</b> (API 키를 넣으면 AI가 요약·답변해드려요)<br>가장 관련 있는 자료예요:</div>` +
          `<div class="md" style="margin-top:10px">${renderMarkdown((top.summary || top.markdown.slice(0, 400)))}</div>` +
          sourcesHtml(docs);
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

// ---------- 위키 ----------
function renderWiki(filter = '') {
  $('#reader').style.display = 'none';
  $('#wikiList').style.display = '';
  const docs = visibleDocs();
  const f = filter.trim().toLowerCase();
  const shown = f
    ? docs.filter(d => (d.title + d.summary + d.markdown).toLowerCase().includes(f))
    : docs;
  const groups = {};
  for (const d of shown) (groups[d.category] ||= []).push(d);
  const cats = Object.keys(groups).sort((a, b) => a.localeCompare(b, 'ko'));
  if (!shown.length) { $('#wikiGroups').innerHTML = `<div class="empty">검색 결과가 없어요.</div>`; return; }
  $('#wikiGroups').innerHTML = cats.map((cat, gi) => `
    <div class="cat-group ${f ? 'open' : (gi === 0 ? 'open' : '')}">
      <div class="cat-head"><span class="arw">▶</span>${escapeHtml(cat)}<span class="cnt">${groups[cat].length}</span></div>
      <div class="doc-list">${groups[cat].map(d => `
        <div class="doc-item" data-doc="${d.id}">
          <div style="flex:1">
            <div class="ti">${escapeHtml(d.title)}</div>
            <div class="sm">${escapeHtml(d.summary || '')}</div>
          </div>
          ${d.audience === 'dentist' ? '<span class="badge dent">치과의사</span>' : ''}
          ${d.uploaded ? '<span class="badge up">추가</span>' : ''}
        </div>`).join('')}</div>
    </div>`).join('');
  $$('.cat-head').forEach(h => h.onclick = () => h.parentElement.classList.toggle('open'));
  $$('.doc-item').forEach(it => it.onclick = () => openDoc(it.dataset.doc));
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
    (d.audience === 'dentist' ? '<span>🦷 치과의사용</span>' : '<span>👥 전직원</span>') +
    (d.source ? `<span>📄 ${escapeHtml(d.source)}</span>` : '');
  $('#readerBody').innerHTML = renderMarkdown(d.markdown);
  bindWikilinks($('#readerBody'));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function bindWikilinks(el) {
  $$('.wlink', el).forEach(w => w.onclick = () => {
    const key = w.dataset.link;
    const d = allDocs().find(x =>
      x.title.includes(key) || (x.source || '').includes(key) || key.includes(x.title));
    if (d) openDoc(d.id); else toast('연결된 자료를 못 찾았어요: ' + key);
  });
}

// ---------- 업로드 ----------
function saveUploads() { LS.set('uploads', state.uploads); }
function addUpload(title, text) {
  if (!text.trim()) return;
  state.uploads.push({
    id: 'up-' + Date.now() + '-' + Math.floor(performance.now()),
    title: title.replace(/\.(md|txt|json|csv|markdown)$/i, ''),
    category: '➕ 추가 자료',
    audience: 'both',
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
    saveUploads(); renderUploads(); renderWiki(); updateKbPill(); toast('삭제했어요');
  });
}
function renderEdu() {
  $('#eduList').innerHTML = state.eduLog.length
    ? state.eduLog.map((e, i) => `
      <div class="edu-item"><span class="dt">${escapeHtml(e.dt)}</span><span style="flex:1">${escapeHtml(e.text)}</span>
      <button class="btn sm ghost del-edu" data-i="${i}" style="color:var(--red)">×</button></div>`).join('')
    : `<div class="empty">교육 기록이 없어요. 무엇을 교육했는지 적어두면 누적돼요.</div>`;
  $$('.del-edu').forEach(b => b.onclick = () => {
    state.eduLog.splice(+b.dataset.i, 1); LS.set('edu', state.eduLog); renderEdu();
  });
}
function readFiles(files) {
  [...files].forEach(f => {
    const r = new FileReader();
    r.onload = () => addUpload(f.name, String(r.result || ''));
    r.readAsText(f);
  });
}

// ---------- 설정 ----------
function openSettings() {
  $('#clinicInput').value = state.clinic;
  $('#apiKeyInput').value = state.apiKey;
  $('#modelSelect').value = state.model;
  updateKeyStatus();
  $('#overlay').classList.add('on');
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
  $('#closeSettings').onclick = () => $('#overlay').classList.remove('on');
  $('#saveSettings').onclick = saveSettings;
  $('#overlay').onclick = e => { if (e.target.id === 'overlay') $('#overlay').classList.remove('on'); };

  $('#qInput').oninput = () => { autosize(); $('#sendBtn').disabled = !$('#qInput').value.trim(); };
  $('#qInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } };
  $('#sendBtn').onclick = ask;

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
    LS.set('edu', state.eduLog); $('#eduInput').value = ''; renderEdu(); toast('교육 기록 추가');
  };

  renderWiki();
}
init();
