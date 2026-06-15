-- 名簿管理（アプリ内CRUD・シート取込）用の列追加
-- Supabase SQL Editor で initial より後に未適用の場合に実行

alter table public.residents add column if not exists legacy_row_key text;
alter table public.residents add column if not exists care_manager_label text;

-- シート取込の upsert 用（legacy_row_key が NULL の行は複数可）
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'residents_organization_id_legacy_row_key_key'
  ) then
    alter table public.residents
      add constraint residents_organization_id_legacy_row_key_key
      unique (organization_id, legacy_row_key);
  end if;
exception
  when duplicate_object then null;
end $$;
