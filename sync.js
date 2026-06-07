// sync.js — 실시간 공유 백엔드 (Supabase REST). 설정 안 하면 비활성(로컬 전용).
// anon 키는 공개돼도 안전한 공개 키(Supabase 설계). 테이블 clinic_store(id text pk, data jsonb).
const cfgGet = () => { try { return JSON.parse(localStorage.getItem('ck_sync') || 'null'); } catch { return null; } };

export const Sync = {
  enabled() { return !!cfgGet(); },
  cfg() { return cfgGet(); },
  setCfg(url, key) {
    url = (url || '').trim().replace(/\/+$/, '');
    localStorage.setItem('ck_sync', JSON.stringify({ url, key: (key || '').trim() }));
  },
  clear() { localStorage.removeItem('ck_sync'); },

  _h() { const c = cfgGet(); return { apikey: c.key, Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' }; },

  // 연결+테이블 확인 (셋업 검증용)
  async test(url, key) {
    url = url.replace(/\/+$/, '');
    const r = await fetch(`${url}/rest/v1/clinic_store?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (r.status === 200) return { ok: true };
    const t = await r.text();
    return { ok: false, status: r.status, msg: t.slice(0, 200) };
  },

  // 공유 데이터 읽기 → {uploads, edu} | null
  async load() {
    const c = cfgGet(); if (!c) return null;
    const r = await fetch(`${c.url}/rest/v1/clinic_store?id=eq.shared&select=data`, { headers: this._h() });
    if (!r.ok) throw new Error('load ' + r.status);
    const rows = await r.json();
    return rows[0]?.data || { uploads: [], edu: [] };
  },

  // 공유 데이터 쓰기 (upsert)
  async save(data) {
    const c = cfgGet(); if (!c) return;
    const r = await fetch(`${c.url}/rest/v1/clinic_store`, {
      method: 'POST',
      headers: { ...this._h(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ id: 'shared', data }]),
    });
    if (!r.ok) throw new Error('save ' + r.status);
  },
};

// 설정 화면에서 복사해 쓰는 1회용 SQL (Supabase SQL editor에 붙여넣기)
export const SETUP_SQL = `create table if not exists clinic_store (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);
alter table clinic_store enable row level security;
create policy "open read"  on clinic_store for select using (true);
create policy "open write" on clinic_store for insert with check (true);
create policy "open update" on clinic_store for update using (true);`;
