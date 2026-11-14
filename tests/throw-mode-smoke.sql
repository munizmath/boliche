-- Aplicar v13-throw-mode.sql antes deste teste. Todos os dados são sintéticos e revertidos.
begin;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000099","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}', true);
set local role authenticated;

do $$
declare
  e constant uuid := '00000000-0000-4000-8000-000000000401';
  p constant uuid := '00000000-0000-4000-8000-000000000402';
  g constant uuid := '00000000-0000-4000-8000-000000000403';
  saved public.scores;
begin
  insert into public.lanes(name,capacity) values('__throw_lane__',6);
  insert into public.players(id,nome,apelido_placar,pista) values(p,'Jogador frame','FRAME','__throw_lane__');
  insert into public.encounters(id,nome,data,status) values(e,'Encontro frame',current_date,'active');
  insert into public.encounter_players(encounter_id,player_id) values(e,p);
  insert into public.games(id,nome,encounter_id,status) values(g,'Partida frame',e,'partial');
  insert into public.scores(game_id,player_id,pista,pontos,finalizado) values(g,p,'__throw_lane__',null,false);

  saved := public.save_throw_score(g,p,'[10,10,10,10,10,10,10,10,10,10,10,10]'::jsonb,'[]'::jsonb,true,'Teste de jogo perfeito');
  if saved.pontos <> 300 or not saved.finalizado then raise exception 'Scorecard não calculou jogo perfeito'; end if;
  if (select count(*) from public.score_details where game_id=g and player_id=p) <> 1 then raise exception 'Detalhe de arremessos não persistido'; end if;
  if (select count(*) from public.throw_changes where game_id=g and player_id=p) <> 1 then raise exception 'Histórico granular não persistido'; end if;

  perform public.set_encounter_closed(e,true);
  begin
    perform public.save_throw_score(g,p,'[0]'::jsonb,'[]'::jsonb,false,'Tentativa bloqueada');
    raise exception 'Encontro encerrado aceitou arremesso';
  exception when insufficient_privilege then null;
  end;
end $$;

select 'throw_mode_smoke_passed' as resultado;
rollback;
