-- Product Families feature
-- Run this entire file once in Supabase SQL Editor.

begin;

create table if not exists public.product_families (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create unique index if not exists product_families_workspace_name_unique
  on public.product_families(workspace_id,lower(trim(name)));

create index if not exists product_families_workspace_idx
  on public.product_families(workspace_id,name);

alter table public.products
  add column if not exists family_id uuid
  references public.product_families(id) on delete set null;

create index if not exists products_family_idx
  on public.products(workspace_id,family_id);

alter table public.product_families enable row level security;

grant select, insert, update, delete
  on public.product_families to authenticated;

drop policy if exists "members read product families"
  on public.product_families;
create policy "members read product families"
  on public.product_families
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

drop policy if exists "owners add product families"
  on public.product_families;
create policy "owners add product families"
  on public.product_families
  for insert to authenticated
  with check (
    created_by=auth.uid()
    and exists(
      select 1
      from public.workspace_members wm
      where wm.workspace_id=product_families.workspace_id
        and wm.user_id=auth.uid()
        and wm.role='owner'
    )
  );

drop policy if exists "owners update product families"
  on public.product_families;
create policy "owners update product families"
  on public.product_families
  for update to authenticated
  using (
    exists(
      select 1
      from public.workspace_members wm
      where wm.workspace_id=product_families.workspace_id
        and wm.user_id=auth.uid()
        and wm.role='owner'
    )
  )
  with check (
    exists(
      select 1
      from public.workspace_members wm
      where wm.workspace_id=product_families.workspace_id
        and wm.user_id=auth.uid()
        and wm.role='owner'
    )
  );

drop policy if exists "owners delete product families"
  on public.product_families;
create policy "owners delete product families"
  on public.product_families
  for delete to authenticated
  using (
    exists(
      select 1
      from public.workspace_members wm
      where wm.workspace_id=product_families.workspace_id
        and wm.user_id=auth.uid()
        and wm.role='owner'
    )
  );

do $$
begin
  if not exists(
    select 1
    from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='product_families'
  ) then
    alter publication supabase_realtime
      add table public.product_families;
  end if;
end $$;

commit;
