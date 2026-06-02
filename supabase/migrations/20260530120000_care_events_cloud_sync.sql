-- CareLink 第1段: 生活記録のクラウド正本（カイポケ型の入口）
-- 前提: 20260430120000_initial_multitenant_residents.sql 適用済み
--
-- 方針:
--   - 端末 localStorage/IDB はそのまま（オフライン優先）
--   - 保存後に Vercel /api/care-sync 経由で upsert（service_role、現場は設定不要）
--   - 日次スナップショットで監査・復元用 JSON も DB に保持

-- ---------------------------------------------------------------------------
-- care_events（1行 = 1記録イベント。client_event_id で端末と突合）
-- ---------------------------------------------------------------------------
create table if not exists public.care_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  facility_id uuid references public.facilities (id) on delete set null,

  client_event_id text not null,
  resident_id text,
  resident_name text,
  facility_sheet_title text,
  event_type text not null,
  event_ts timestamptz not null,
  payload jsonb not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, client_event_id)
);

create index if not exists idx_care_events_org_ts
  on public.care_events (organization_id, event_ts desc);

create index if not exists idx_care_events_facility_ts
  on public.care_events (facility_id, event_ts desc);

create index if not exists idx_care_events_resident_ts
  on public.care_events (organization_id, resident_id, event_ts desc);

create index if not exists idx_care_events_type
  on public.care_events (organization_id, event_type);

-- ---------------------------------------------------------------------------
-- care_daily_snapshots（施設×日のバックアップ JSON。23:59 自動と手動）
-- ---------------------------------------------------------------------------
create table if not exists public.care_daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  facility_id uuid references public.facilities (id) on delete set null,

  snapshot_ymd date not null,
  facility_label text not null default '',
  trigger text not null default 'manual' check (trigger in ('manual', 'auto2359', 'import')),
  event_count integer not null default 0,
  payload jsonb not null default '{}',

  created_at timestamptz not null default now(),

  unique (organization_id, facility_id, snapshot_ymd, trigger)
);

create index if not exists idx_care_daily_snapshots_org_ymd
  on public.care_daily_snapshots (organization_id, snapshot_ymd desc);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists trg_care_events_updated_at on public.care_events;
create trigger trg_care_events_updated_at
  before update on public.care_events
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: クライアント直書きはしない（/api/care-sync が service_role で upsert）
-- 将来 Auth 導入時は select のみ member に開放
-- ---------------------------------------------------------------------------
alter table public.care_events enable row level security;
alter table public.care_daily_snapshots enable row level security;

create policy "care_events_select_member_org"
  on public.care_events for select
  using (
    organization_id in (
      select organization_id from public.organization_members where user_id = auth.uid()
    )
  );

create policy "care_daily_snapshots_select_member_org"
  on public.care_daily_snapshots for select
  using (
    organization_id in (
      select organization_id from public.organization_members where user_id = auth.uid()
    )
  );

comment on table public.care_events is '生活記録イベント（クラウド正本）。Vercel /api/care-sync 経由で upsert';
comment on table public.care_daily_snapshots is '施設×日のバックアップ JSON（5年保管のクラウド側）';

-- ---------------------------------------------------------------------------
-- 初期データ例（自社6施設・1 organization）— UUID はプロジェクトごとに差し替え
-- ---------------------------------------------------------------------------
-- insert into public.organizations (id, name, slug)
-- values ('00000000-0000-4000-8000-000000000001', 'ケアサポート・ブレインエナジー', 'carelink-main')
-- on conflict (slug) do nothing;
--
-- insert into public.facilities (organization_id, sheet_title, tab_label, link_key) values
--   ('00000000-0000-4000-8000-000000000001', '中川本館：入居者', '中川本館', '中川本館'),
--   ('00000000-0000-4000-8000-000000000001', '愛西：入居者', 'シルバーマンション愛西', '愛西'),
--   ('00000000-0000-4000-8000-000000000001', '★北名古屋：入居者', 'CSナーシング北名古屋', '北名古屋'),
--   ('00000000-0000-4000-8000-000000000001', '☆千音寺：入居者', 'CSナーシング千音寺', '千音寺'),
--   ('00000000-0000-4000-8000-000000000001', '●青空起：入居者', 'ナーシングホーム青空起', '起'),
--   ('00000000-0000-4000-8000-000000000001', '●青空一宮：入居者', 'ナーシングホーム青空', '一宮')
-- on conflict (organization_id, sheet_title) do nothing;
