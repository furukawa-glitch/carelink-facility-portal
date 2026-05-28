-- =============================================================================
-- DEV / 検証用: anon（未ログイン）でも名簿テーブルを SELECT できるポリシー
-- 本番で Supabase Auth + organization_members に切り替えたら、このマイグレーションの
-- ポリシーは DROP して元の member のみの RLS に戻してください。
-- =============================================================================

drop policy if exists "dev_anon_read_residents" on public.residents;
create policy "dev_anon_read_residents"
  on public.residents
  for select
  to anon
  using (true);

drop policy if exists "dev_anon_read_facilities" on public.facilities;
create policy "dev_anon_read_facilities"
  on public.facilities
  for select
  to anon
  using (true);

drop policy if exists "dev_anon_read_organizations" on public.organizations;
create policy "dev_anon_read_organizations"
  on public.organizations
  for select
  to anon
  using (true);

-- 元に戻す例（SQL Editor で実行）:
-- drop policy if exists "dev_anon_read_residents" on public.residents;
-- drop policy if exists "dev_anon_read_facilities" on public.facilities;
-- drop policy if exists "dev_anon_read_organizations" on public.organizations;
