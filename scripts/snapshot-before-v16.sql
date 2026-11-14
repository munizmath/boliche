-- Execute uma vez imediatamente antes de v16-multigame-integrity.sql.
-- O schema privado não é exposto pela API pública do projeto.
begin;
create schema if not exists migration_backup;
create table migration_backup.pre_v16_20261114 as
select now() as captured_at,
       jsonb_build_object(
         'lanes', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.lanes t),
         'players', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.players t),
         'profiles', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.profiles t),
         'encounters', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.encounters t),
         'encounter_players', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.encounter_players t),
         'games', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.games t),
         'scores', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.scores t),
         'score_changes', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.score_changes t),
         'score_details', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.score_details t),
         'throw_changes', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.throw_changes t),
         'round_scores', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.round_scores t),
         'round_score_changes', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.round_score_changes t),
         'teams', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.teams t),
         'team_players', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.team_players t),
         'brackets', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.brackets t),
         'predictions', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.predictions t)
       ) as data;
alter table migration_backup.pre_v16_20261114 enable row level security;
commit;

-- Verificação sem expor os registros do snapshot.
select captured_at, pg_column_size(data) as bytes,
       md5(data::text) as checksum,
       jsonb_object_keys(data) as table_name
  from migration_backup.pre_v16_20261114;
