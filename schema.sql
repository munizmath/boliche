-- Boliche dos Amigos / Supabase
-- Execute no SQL Editor do projeto antes de publicar o frontend.

create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 1 and 80),
  apelido_placar text not null check (length(trim(apelido_placar)) between 1 and 80),
  pista text not null check (length(trim(pista)) between 1 and 20),
  created_at timestamptz not null default now()
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 1 and 80),
  status text not null default 'partial' check (status in ('partial', 'final')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete restrict,
  pontos integer check (pontos is null or pontos between 0 and 300),
  finalizado boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (game_id, player_id),
  check (not finalizado or pontos is not null)
);

create index if not exists scores_game_id_idx on public.scores(game_id);
create index if not exists scores_player_id_idx on public.scores(player_id);
create index if not exists scores_updated_at_idx on public.scores(updated_at desc);
create index if not exists games_status_idx on public.games(status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists players_updated_at on public.players;
drop trigger if exists games_updated_at on public.games;
drop trigger if exists scores_updated_at on public.scores;
create trigger games_updated_at before update on public.games for each row execute function public.set_updated_at();
create trigger scores_updated_at before update on public.scores for each row execute function public.set_updated_at();

-- Definido no app_metadata do usuário, que não pode ser alterado pelo navegador.
create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.scores enable row level security;

drop policy if exists players_public_read on public.players;
drop policy if exists players_admin_insert on public.players;
drop policy if exists players_admin_update on public.players;
drop policy if exists players_admin_delete on public.players;
create policy players_public_read on public.players for select to anon, authenticated using (true);
create policy players_admin_insert on public.players for insert to authenticated with check ((select public.is_admin()));
create policy players_admin_update on public.players for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy players_admin_delete on public.players for delete to authenticated using ((select public.is_admin()));

drop policy if exists games_public_read on public.games;
drop policy if exists games_admin_insert on public.games;
drop policy if exists games_admin_update on public.games;
drop policy if exists games_admin_delete on public.games;
create policy games_public_read on public.games for select to anon, authenticated using (true);
create policy games_admin_insert on public.games for insert to authenticated with check ((select public.is_admin()));
create policy games_admin_update on public.games for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy games_admin_delete on public.games for delete to authenticated using ((select public.is_admin()));

drop policy if exists scores_public_read on public.scores;
drop policy if exists scores_admin_insert on public.scores;
drop policy if exists scores_admin_update on public.scores;
drop policy if exists scores_admin_delete on public.scores;
create policy scores_public_read on public.scores for select to anon, authenticated using (true);
create policy scores_admin_insert on public.scores for insert to authenticated with check ((select public.is_admin()));
create policy scores_admin_update on public.scores for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy scores_admin_delete on public.scores for delete to authenticated using ((select public.is_admin()));

grant usage on schema public to anon, authenticated;
grant select on public.players, public.games, public.scores to anon, authenticated;
grant insert, update, delete on public.players, public.games, public.scores to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'players') then
    alter publication supabase_realtime add table public.players;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'games') then
    alter publication supabase_realtime add table public.games;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scores') then
    alter publication supabase_realtime add table public.scores;
  end if;
end;
$$;

-- Depois de criar o usuário administrador no Auth, substitua o e-mail e execute:
-- update auth.users
-- set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
-- where email = 'seu-email@exemplo.com';
