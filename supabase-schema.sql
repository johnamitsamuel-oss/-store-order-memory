-- Store Order Memory V2 - fresh setup
-- Run this whole file once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id,user_id)
);
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  supplier text,
  reorder_weeks integer not null default 1 check (reorder_weeks between 1 and 52),
  default_quantity integer not null default 1 check (default_quantity between 1 and 999),
  active boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  product_name text not null,
  supplier text,
  quantity integer not null check (quantity between 1 and 999),
  ordered_on date not null default current_date,
  ordered_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workspace_members_user_idx on public.workspace_members(user_id);
create index if not exists products_workspace_idx on public.products(workspace_id,active);
create index if not exists orders_workspace_date_idx on public.orders(workspace_id,ordered_on desc);
create index if not exists orders_product_date_idx on public.orders(product_id,ordered_on desc);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;

create or replace function public.is_workspace_member(p_workspace uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.workspace_members wm where wm.workspace_id=p_workspace and wm.user_id=auth.uid());
$$;
revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;

drop policy if exists "members read workspaces" on public.workspaces;
create policy "members read workspaces" on public.workspaces for select to authenticated using (public.is_workspace_member(id));
drop policy if exists "members read memberships" on public.workspace_members;
create policy "members read memberships" on public.workspace_members for select to authenticated using (public.is_workspace_member(workspace_id));

drop policy if exists "members read products" on public.products;
create policy "members read products" on public.products for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "members add products" on public.products;
create policy "members add products" on public.products for insert to authenticated with check (created_by=auth.uid() and public.is_workspace_member(workspace_id));
drop policy if exists "members update products" on public.products;
create policy "members update products" on public.products for update to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

drop policy if exists "members read orders" on public.orders;
create policy "members read orders" on public.orders for select to authenticated using (public.is_workspace_member(workspace_id));
drop policy if exists "members add orders" on public.orders;
create policy "members add orders" on public.orders for insert to authenticated with check (ordered_by=auth.uid() and public.is_workspace_member(workspace_id));
drop policy if exists "members update orders" on public.orders;
create policy "members update orders" on public.orders for update to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
drop policy if exists "members delete orders" on public.orders;
create policy "members delete orders" on public.orders for delete to authenticated using (public.is_workspace_member(workspace_id));

create or replace function public.create_workspace(p_name text)
returns uuid language plpgsql security definer set search_path=public as $$
declare new_id uuid; new_code text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if trim(coalesce(p_name,''))='' then raise exception 'Store name is required'; end if;
  loop
    new_code:=upper(substr(encode(gen_random_bytes(6),'hex'),1,8));
    exit when not exists(select 1 from public.workspaces where invite_code=new_code);
  end loop;
  insert into public.workspaces(name,invite_code,created_by) values(trim(p_name),new_code,auth.uid()) returning id into new_id;
  insert into public.workspace_members(workspace_id,user_id,role) values(new_id,auth.uid(),'owner');
  return new_id;
end;$$;
revoke all on function public.create_workspace(text) from public;
grant execute on function public.create_workspace(text) to authenticated;

create or replace function public.join_workspace(p_invite_code text)
returns uuid language plpgsql security definer set search_path=public as $$
declare target_id uuid; member_count integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  select id into target_id from public.workspaces where invite_code=upper(trim(p_invite_code));
  if target_id is null then raise exception 'Invite code not found'; end if;
  if exists(select 1 from public.workspace_members where workspace_id=target_id and user_id=auth.uid()) then return target_id; end if;
  select count(*) into member_count from public.workspace_members where workspace_id=target_id;
  if member_count>=2 then raise exception 'This store already has two users'; end if;
  insert into public.workspace_members(workspace_id,user_id,role) values(target_id,auth.uid(),'member');
  return target_id;
end;$$;
revoke all on function public.join_workspace(text) from public;
grant execute on function public.join_workspace(text) to authenticated;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end;$$;
drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at before update on public.orders for each row execute function public.touch_updated_at();

do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='products') then alter publication supabase_realtime add table public.products; end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='orders') then alter publication supabase_realtime add table public.orders; end if;
end $$;
