-- Dados sintéticos; nenhuma partida ou usuário real é necessário. Tudo é revertido.
begin;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000099","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',true);
set local role authenticated;
do $$
declare
  e1 constant uuid := '00000000-0000-4000-8000-000000000301';
  e2 constant uuid := '00000000-0000-4000-8000-000000000302';
  p1 constant uuid := '00000000-0000-4000-8000-000000000311';
  p2 constant uuid := '00000000-0000-4000-8000-000000000312';
  p3 constant uuid := '00000000-0000-4000-8000-000000000313';
  p4 constant uuid := '00000000-0000-4000-8000-000000000314';
  g1 public.games; g2 public.games; g3 public.games;
  e3 public.encounters;
begin
  insert into public.lanes(name,capacity) values('__onda_l1__',2),('__onda_l2__',2);
  insert into public.players(id,nome,apelido_placar,pista) values
    (p1,'Sintético A','A','__onda_l1__'),(p2,'Sintético B','B','__onda_l1__'),
    (p3,'Sintético C','C','__onda_l2__'),(p4,'Sintético D','D','__onda_l2__');
  insert into public.encounters(id,nome,data,status) values
    (e1,'Encontro sintético 1',current_date,'active'),(e2,'Encontro sintético 2',current_date,'active');
  insert into public.encounter_players(encounter_id,player_id)
    select e1,id from public.players where id in (p1,p2,p3,p4);
  insert into public.encounter_players(encounter_id,player_id) values(e2,p1),(e2,p2);
  e3 := public.create_encounter('Repetição sintética',current_date,array[p1], '00000000-0000-4000-8000-000000000324');
  if e3.id <> (public.create_encounter('Repetição sintética',current_date,array[p1], '00000000-0000-4000-8000-000000000324')).id then raise exception 'Encontro duplicado por repetição'; end if;
  g1 := public.create_encounter_game(e1,'Primeira',jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__onda_l1__'),jsonb_build_object('player_id',p2,'pista','__onda_l1__'),
    jsonb_build_object('player_id',p3,'pista','__onda_l2__'),jsonb_build_object('player_id',p4,'pista','__onda_l2__')),'00000000-0000-4000-8000-000000000321');
  g2 := public.create_encounter_game(e1,'Segunda',jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__onda_l2__'),jsonb_build_object('player_id',p2,'pista','__onda_l2__'),
    jsonb_build_object('player_id',p3,'pista','__onda_l1__'),jsonb_build_object('player_id',p4,'pista','__onda_l1__')),'00000000-0000-4000-8000-000000000322');
  g3 := public.create_encounter_game(e2,'Outro encontro',jsonb_build_array(
    jsonb_build_object('player_id',p1,'pista','__onda_l1__'),jsonb_build_object('player_id',p2,'pista','__onda_l1__')),'00000000-0000-4000-8000-000000000323');
  if g1.id <> (public.create_encounter_game(e1,'Primeira',jsonb_build_array(jsonb_build_object('player_id',p1,'pista','__onda_l1__')), '00000000-0000-4000-8000-000000000321')).id then raise exception 'Partida duplicada por repetição'; end if;
  if (select pista from public.scores where game_id=g1.id and player_id=p1)<>'__onda_l1__'
    or (select pista from public.scores where game_id=g2.id and player_id=p1)<>'__onda_l2__' then raise exception 'Pista histórica não preservada'; end if;
  perform public.save_game_scores(g1.id,jsonb_build_array(
    jsonb_build_object('player_id',p1,'pontos',100,'finalizado',true),jsonb_build_object('player_id',p2,'pontos',90,'finalizado',true),
    jsonb_build_object('player_id',p3,'pontos',80,'finalizado',true),jsonb_build_object('player_id',p4,'pontos',70,'finalizado',true)));
  perform public.save_game_scores(g2.id,jsonb_build_array(
    jsonb_build_object('player_id',p1,'pontos',0,'finalizado',true),jsonb_build_object('player_id',p2,'pontos',95,'finalizado',true),
    jsonb_build_object('player_id',p3,'pontos',85,'finalizado',true),jsonb_build_object('player_id',p4,'pontos',75,'finalizado',true)));
  perform public.save_game_scores(g3.id,jsonb_build_array(
    jsonb_build_object('player_id',p1,'pontos',200,'finalizado',true),jsonb_build_object('player_id',p2,'pontos',100,'finalizado',true)));
  if (select sum(s.pontos) from public.scores s join public.games g on g.id=s.game_id where g.encounter_id=e1 and s.player_id=p1)<>100
    or (select sum(s.pontos) from public.scores s join public.games g on g.id=s.game_id where g.encounter_id=e2 and s.player_id=p1)<>200 then raise exception 'Rankings dos encontros se misturaram'; end if;
  perform public.save_team(null,e1,'Equipe Alfa','average',array[p1,p2]);
  begin
    perform public.save_team(null,e1,'Equipe Inválida','sum',array[p1,p3]);
    raise exception 'Jogador entrou em duas equipes';
  exception when check_violation then null;
  end;
  perform public.save_bracket(e1,array[p1,p2,p3,p4],array[g1.id,g2.id],'higher_seed');
  if not exists(select 1 from public.brackets where encounter_id=e1 and cardinality(seeds)=4) then raise exception 'Chave de quatro falhou'; end if;
  perform public.set_encounter_closed(e1,true);
  begin
    update public.scores set pontos=200 where game_id=g1.id and player_id=p1;
    raise exception 'Encontro encerrado aceitou pontos';
  exception when insufficient_privilege then null;
  end;
  perform public.set_encounter_closed(e1,false);
  if (select status from public.encounters where id=e1)<>'active' then raise exception 'Reabertura falhou'; end if;
end $$;
select 'encounter_smoke_passed' as resultado;
rollback;
