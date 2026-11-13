-- Aplicar todas as migrações antes deste teste. Dados sintéticos são revertidos.
begin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}', true);
set local role authenticated;

do $$
declare
  test_encounter_id constant uuid := '00000000-0000-4000-8000-000000000201';
  test_game_id constant uuid := '00000000-0000-4000-8000-000000000202';
  test_player_id constant uuid := '00000000-0000-4000-8000-000000000203';
begin
  if not public.is_admin() then raise exception 'Simulação de administrador falhou'; end if;
  insert into public.lanes(name,capacity) values('__gestao_sql__',6);
  insert into public.players(id,nome,apelido_placar,pista) values(test_player_id,'Jogador sintético','GESTAO','__gestao_sql__');
  insert into public.encounters(id,nome,data,status) values(test_encounter_id,'Gestão sintética',current_date,'active');
  insert into public.encounter_players(encounter_id,player_id) values(test_encounter_id,test_player_id);
  insert into public.games(id,nome,encounter_id) values(test_game_id,'Partida sintética',test_encounter_id);
  insert into public.scores(game_id,player_id,pista) values(test_game_id,test_player_id,'__gestao_sql__');

  perform public.edit_game(test_game_id,'Partida editada',array[test_player_id]);
  if not exists(select 1 from public.games where id=test_game_id and nome='Partida editada') then raise exception 'Edição da partida falhou'; end if;
  perform public.save_game_scores(test_game_id,jsonb_build_array(jsonb_build_object('player_id',test_player_id,'pontos',100,'finalizado',false)));
  perform public.clear_game_score(test_game_id,test_player_id);
  if exists(select 1 from public.scores where game_id=test_game_id and pontos is not null) then raise exception 'Limpeza de pontos falhou'; end if;
  update public.lanes set name='__gestao_nova__' where name='__gestao_sql__';
  if not exists(select 1 from public.players where id=test_player_id and pista='__gestao_nova__') then raise exception 'Renomeação da pista falhou'; end if;
  if not exists(select 1 from public.scores where game_id=test_game_id and pista='__gestao_sql__') then raise exception 'Pista histórica foi alterada'; end if;
  perform public.delete_player_cascade(test_player_id);
  if exists(select 1 from public.players where id=test_player_id) then raise exception 'Exclusão de jogador falhou'; end if;
  delete from public.games where id=test_game_id;
  if exists(select 1 from public.games where id=test_game_id) then raise exception 'Exclusão de partida falhou'; end if;
end $$;

select 'management_smoke_passed' as resultado;
rollback;
