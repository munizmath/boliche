-- Aplicar todas as migrações antes deste teste. Nenhum registro preexistente é usado.
begin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}', true);
set local role authenticated;

do $$
declare
  test_encounter_id constant uuid := '00000000-0000-4000-8000-000000000101';
  test_game_id constant uuid := '00000000-0000-4000-8000-000000000102';
  test_player_id constant uuid := '00000000-0000-4000-8000-000000000103';
  audit_count integer;
  last_change bigint;
  affected integer;
begin
  if not public.is_admin() then raise exception 'Simulação de administrador falhou'; end if;
  insert into public.lanes(name,capacity) values('__teste_sql__',6);
  insert into public.players(id,nome,apelido_placar,pista) values(test_player_id,'Jogador de teste','TESTE','__teste_sql__');
  insert into public.encounters(id,nome,data,status) values(test_encounter_id,'Encontro de teste',current_date,'active');
  insert into public.encounter_players(encounter_id,player_id) values(test_encounter_id,test_player_id);
  insert into public.games(id,nome,encounter_id) values(test_game_id,'Partida de teste',test_encounter_id);
  insert into public.scores(game_id,player_id,pista,pontos,finalizado) values(test_game_id,test_player_id,'__teste_sql__',null,false);
  perform public.save_game_scores(test_game_id,jsonb_build_array(jsonb_build_object('player_id',test_player_id,'pontos',0,'finalizado',true)));
  if not exists(select 1 from public.games where id=test_game_id and status='final') then raise exception 'Status final não acompanhou a pontuação'; end if;
  if (select count(*) from public.scores where game_id=test_game_id)<>1 then raise exception 'Importação duplicou participante'; end if;
  select count(*) into audit_count from public.score_changes where game_id=test_game_id;
  perform public.save_game_scores(test_game_id,jsonb_build_array(jsonb_build_object('player_id',test_player_id,'pontos',0,'finalizado',true)));
  if (select count(*) from public.score_changes where game_id=test_game_id)<>audit_count then raise exception 'Reimportação criou alteração redundante'; end if;
  select max(id) into last_change from public.score_changes where game_id=test_game_id;
  perform public.undo_score_change(last_change);
  if not exists(select 1 from public.games where id=test_game_id and status='partial') then raise exception 'Desfazer não restaurou partida parcial'; end if;

  perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000098","role":"authenticated","app_metadata":{"role":"player"},"amr":[{"method":"password"}]}',true);
  begin
    perform public.save_game_scores(test_game_id,jsonb_build_array(jsonb_build_object('player_id',test_player_id,'pontos',100,'finalizado',true)));
    raise exception 'Usuário comum conseguiu publicar pontos';
  exception when insufficient_privilege then null;
  end;
  update public.scores set pontos=100 where id=(select id from public.scores where game_id=test_game_id);
  get diagnostics affected = row_count;
  if affected<>0 then raise exception 'RLS permitiu alterar pontos'; end if;
end $$;

select 'transaction_smoke_passed' as resultado;
rollback;
