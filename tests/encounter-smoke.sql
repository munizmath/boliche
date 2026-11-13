-- Executar no SQL Editor após encounters.sql e competition.sql. Nenhuma alteração persiste.
begin;
select set_config('request.jwt.claims', '{"app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}', true);

do $$
declare
  player_id uuid;
  lane_name text;
  event_row public.encounters;
  game_row public.games;
  team_row public.teams;
begin
  select p.id,p.pista into player_id,lane_name from public.players p order by p.created_at limit 1;
  if player_id is null then raise exception 'O ensaio precisa de um jogador real já cadastrado'; end if;
  if not public.is_admin() then raise exception 'A simulação de admin não foi reconhecida'; end if;

  event_row:=public.create_encounter('Ensaio reversível',current_date,array[player_id]);
  team_row:=public.save_team(null,event_row.id,'Equipe de ensaio','sum',array[player_id]);
  if team_row.encounter_id<>event_row.id then raise exception 'Equipe fora do encontro'; end if;

  game_row:=public.create_encounter_game(event_row.id,'Partida de ensaio',
    jsonb_build_array(jsonb_build_object('player_id',player_id,'pista',lane_name)));
  if not exists(select 1 from public.scores where game_id=game_row.id and pista=lane_name) then
    raise exception 'Pista não foi gravada na partida';
  end if;
  perform public.save_game_scores(game_row.id,
    jsonb_build_array(jsonb_build_object('player_id',player_id,'pontos',123,'finalizado',true)));
  if not exists(select 1 from public.games where id=game_row.id and status='final') then
    raise exception 'Partida não foi finalizada';
  end if;
  perform public.set_encounter_closed(event_row.id,true);
  begin
    update public.scores set pontos=124 where game_id=game_row.id;
    raise exception 'Encontro encerrado aceitou mudança de pontos';
  exception when insufficient_privilege then null;
  end;
  perform public.set_encounter_closed(event_row.id,false);
  perform public.delete_encounter(event_row.id);
  if exists(select 1 from public.encounters where id=event_row.id) then
    raise exception 'Exclusão do encontro falhou';
  end if;
end $$;

select 'Ensaio concluído e revertido' as resultado;
rollback;
