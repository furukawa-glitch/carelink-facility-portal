-- 職員ログイン（カイポケ型: 職員コード + パスワード）
-- ふれあいの里（ケアリンク）等、VITE_STAFF_LOGIN_ENABLED=1 のデプロイで使用。
-- パスワードは平文保存せず、/api/staff-auth が scrypt ハッシュのみ保存。

create table if not exists public.staff_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  staff_code text not null,
  display_name text not null default '',
  password_hash text not null,
  is_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, staff_code)
);

create index if not exists idx_staff_accounts_org_active
  on public.staff_accounts (organization_id, active);

drop trigger if exists trg_staff_accounts_updated_at on public.staff_accounts;
create trigger trg_staff_accounts_updated_at
  before update on public.staff_accounts
  for each row execute function public.set_updated_at();

alter table public.staff_accounts enable row level security;

-- ブラウザからの直接参照は不可（service_role 経由の API のみ）
comment on table public.staff_accounts is '施設ポータル職員アカウント（職員コードログイン）';
