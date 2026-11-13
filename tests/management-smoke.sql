-- Execute após management.sql. Tudo é revertido no final.
begin;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', (select id::text from auth.users where raw_app_meta_data ->> 'role' = 'admin' limit 1),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin'),
  'amr', jsonb_build_array(jsonb_build_object('method', 'password'))
)::text, true);
set local role authenticated;

do $$
declare
  target_game uuid;
  target_player uuid;
  player_ids uuid[];
  old_lane text;
  new_lane text := left('TESTE-' || replace(gen_random_uuid()::text, '-', ''), 20);
begin
  if (select count(*) from public.list_registered_accounts()) < 1 then
    raise exception 'A lista administrativa de contas falhou';
  end if;
  select game_id, player_id into target_game, target_player from public.scores limit 1;
  select array_agg(player_id) into player_ids from public.scores where game_id = target_game;
  perform public.edit_game(target_game, 'Partida de teste', player_ids);
  if (select nome from public.games where id = target_game) <> 'Partida de teste' then
    raise exception 'Edição da partida falhou';
  end if;
  perform public.save_game_scores(target_game, jsonb_build_array(
    jsonb_build_object('player_id', target_player, 'pontos', 100, 'finalizado', false)
  ));
  perform public.clear_game_score(target_game, target_player);
  if (select pontos from public.scores where game_id = target_game and player_id = target_player) is not null then
    raise exception 'Limpeza de pontuação falhou';
  end if;
  select pista into old_lane from public.players where id = target_player;
  update public.lanes set name = new_lane where name = old_lane;
  if (select pista from public.players where id = target_player) <> new_lane then
    raise exception 'Renomeação da pista não atualizou o jogador';
  end if;
  perform public.delete_player_cascade(target_player);
  if exists (select 1 from public.players where id = target_player) then
    raise exception 'Exclusão de jogador falhou';
  end if;
  delete from public.games where id = target_game;
  if exists (select 1 from public.games where id = target_game) then
    raise exception 'Exclusão de partida falhou';
  end if;
end;
$$;

select 'passed' as management_smoke;
rollback;
