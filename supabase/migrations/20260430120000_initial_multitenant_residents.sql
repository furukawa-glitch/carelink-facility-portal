-- CareLink: マルチテナント基盤 + 名簿（スプレッドシート相当カラム）
-- アプリ側 rowsToResidents の主要フィールドを residents に正規化。
-- シート固有・未知カラムは custom_fields (jsonb) に保持可能。
--
-- 適用: Supabase Dashboard → SQL Editor で実行、または CLI で migration

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- organizations（会社・運営単位）
-- ---------------------------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_organizations_slug on public.organizations (slug);

-- ---------------------------------------------------------------------------
-- organization_members（Supabase Auth ユーザーと組織の紐付け・RLS 用）
-- auth.users の id を user_id に格納（UUID）
-- ---------------------------------------------------------------------------
create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index if not exists idx_org_members_user_id on public.organization_members (user_id);
create index if not exists idx_org_members_org_id on public.organization_members (organization_id);

alter table public.organization_members enable row level security;

-- メンバーは自分の行だけ読める（プロフィール用途）
create policy "org_members_select_self"
  on public.organization_members for select
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- facilities（施設 = スプレッドシートのタブ／事業所単位）
-- organization_id でテナント分離。sheet_title は既存 CARELINK の sheetTitle と対応想定。
-- ---------------------------------------------------------------------------
create table if not exists public.facilities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sheet_title text not null,
  tab_label text,
  link_key text,
  licensed_beds integer,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, sheet_title)
);

create index if not exists idx_facilities_organization_id on public.facilities (organization_id);

-- ---------------------------------------------------------------------------
-- residents（利用者名簿・1行 = 1利用者）
-- GoogleSheetService.rowsToResidents と対応する列 + 同期用メタ
-- ---------------------------------------------------------------------------
create table if not exists public.residents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  facility_id uuid references public.facilities (id) on delete set null,

  -- 既存アプリの合成IDに相当する外部キー（同期ジョブで使用）
  legacy_row_key text,

  name text not null,
  name_kana text,
  room text,
  sheet_status text,

  care_level_label text,
  condition_note text,

  insurance_label text,
  insurance_category text,
  medical_insurance_target_label text,
  is_medical_insurance_target boolean not null default false,

  birth_date_label text,
  age_label text,
  gender_label text,

  home_doctor text,

  meal_count_this_month integer not null default 0,
  is_enteral boolean not null default false,

  -- 同期・監査
  source_sheet_title text,
  last_synced_at timestamptz,
  sheet_row_number integer,

  -- スプレッドシートのその他列をそのまま逃がす（全項目カバー用）
  custom_fields jsonb not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, legacy_row_key)
);

create index if not exists idx_residents_organization_id on public.residents (organization_id);
create index if not exists idx_residents_facility_id on public.residents (facility_id);
create index if not exists idx_residents_name on public.residents (organization_id, name);
create index if not exists idx_residents_room on public.residents (organization_id, room);

-- ---------------------------------------------------------------------------
-- updated_at 自動更新（共通トリガー関数）
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_organizations_updated_at on public.organizations;
create trigger trg_organizations_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

drop trigger if exists trg_facilities_updated_at on public.facilities;
create trigger trg_facilities_updated_at
  before update on public.facilities
  for each row execute function public.set_updated_at();

drop trigger if exists trg_residents_updated_at on public.residents;
create trigger trg_residents_updated_at
  before update on public.residents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS（Row Level Security）
-- auth.uid() → organization_members → organization_id で施設・利用者を分離。
-- organizations / organization_members の初期投入は service_role または Dashboard の SQL（RLS バイパス）推奨。
-- ---------------------------------------------------------------------------
alter table public.organizations enable row level security;
alter table public.facilities enable row level security;
alter table public.residents enable row level security;

-- 認証ユーザーは所属 organization の施設・利用者のみ CRUD（必要に応じて insert/update を分離）
create policy "facilities_select_member_org"
  on public.facilities for select
  using (
    organization_id in (
      select organization_id from public.organization_members where user_id = auth.uid()
    )
  );

create policy "facilities_write_member_org"
  on public.facilities for all
  using (
    organization_id in (
      select organization_id from public.organization_members
      where user_id = auth.uid() and role in ('owner', 'admin', 'member')
    )
  )
  with check (
    organization_id in (
      select organization_id from public.organization_members
      where user_id = auth.uid() and role in ('owner', 'admin', 'member')
    )
  );

create policy "residents_select_member_org"
  on public.residents for select
  using (
    organization_id in (
      select organization_id from public.organization_members where user_id = auth.uid()
    )
  );

create policy "residents_write_member_org"
  on public.residents for all
  using (
    organization_id in (
      select organization_id from public.organization_members
      where user_id = auth.uid() and role in ('owner', 'admin', 'member')
    )
  )
  with check (
    organization_id in (
      select organization_id from public.organization_members
      where user_id = auth.uid() and role in ('owner', 'admin', 'member')
    )
  );

-- organizations 自体は「自分がメンバーの行のみ」参照にする例（運用に合わせ調整）
create policy "organizations_select_member"
  on public.organizations for select
  using (
    id in (
      select organization_id from public.organization_members where user_id = auth.uid()
    )
  );

comment on table public.organizations is 'マルチテナント: 会社・運営単位';
comment on table public.organization_members is 'Auth ユーザーと organization の対応（RLS の基準）';
comment on table public.facilities is '施設（スプレッドシートタブ相当）。organization_id で分離';
comment on table public.residents is '利用者名簿。organization_id 必須。custom_fields にシート拡張列';
