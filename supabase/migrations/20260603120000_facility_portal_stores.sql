-- 予定カレンダー・往診カレンダー等（施設単位 localStorage のクラウド共有）
-- /api/care-sync の upsert_facility_store / pull_facility_stores で同期

create table if not exists public.facility_portal_stores (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  store_type text not null,
  facility_link_key text not null,
  payload jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (organization_id, store_type, facility_link_key)
);

create index if not exists idx_facility_portal_stores_org_updated
  on public.facility_portal_stores (organization_id, updated_at desc);

drop trigger if exists trg_facility_portal_stores_updated_at on public.facility_portal_stores;
create trigger trg_facility_portal_stores_updated_at
  before update on public.facility_portal_stores
  for each row execute function public.set_updated_at();

alter table public.facility_portal_stores enable row level security;

create policy "facility_portal_stores_select_member_org"
  on public.facility_portal_stores for select
  using (
    organization_id in (
      select om.organization_id from public.organization_members om
      where om.user_id = auth.uid()
    )
  );

comment on table public.facility_portal_stores is '施設ポータル共有データ（週間予定・往診カレンダー等）';
