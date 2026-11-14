-- Testa RLS de perfil e Storage com conta sintética; executar no SQL Editor. Nada persiste.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values('00000000-0000-4000-8000-000000000401','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','v12-privacy@example.invalid','',now(),now());
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000401","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',true);
set local role authenticated;
insert into public.lanes(name,capacity) values('__privacidade__',1);
insert into public.players(id,nome,apelido_placar,pista)
values('00000000-0000-4000-8000-000000000402','Jogador privado','PRIVADO','__privacidade__');
insert into public.profiles(id,nome,foto_path,status,player_id,photo_public_opt_in)
values('00000000-0000-4000-8000-000000000401','Perfil sintético',
  '00000000-0000-4000-8000-000000000401/photo.jpg','approved','00000000-0000-4000-8000-000000000402',false);
insert into storage.objects(bucket_id,name)
values('profile-photos','00000000-0000-4000-8000-000000000401/photo.jpg');

set local role anon;
do $$ begin
  if exists(select 1 from public.profiles where id='00000000-0000-4000-8000-000000000401')
    or exists(select 1 from storage.objects where name='00000000-0000-4000-8000-000000000401/photo.jpg') then
    raise exception 'Foto sem consentimento exposta';
  end if;
end $$;
set local role authenticated;
update public.profiles set photo_public_opt_in=true where id='00000000-0000-4000-8000-000000000401';
set local role anon;
do $$ begin
  if not exists(select 1 from public.profiles where id='00000000-0000-4000-8000-000000000401')
    or not exists(select 1 from storage.objects where name='00000000-0000-4000-8000-000000000401/photo.jpg') then
    raise exception 'Foto aprovada e autorizada indisponível';
  end if;
end $$;
set local role authenticated;
update public.profiles set photo_public_opt_in=false where id='00000000-0000-4000-8000-000000000401';
set local role anon;
do $$ begin
  if exists(select 1 from storage.objects where name='00000000-0000-4000-8000-000000000401/photo.jpg') then
    raise exception 'Revogação não bloqueou novas consultas';
  end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000401","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',true);
insert into public.encounters(id,nome,data,status)
values('00000000-0000-4000-8000-000000000403','Palpite sintético',current_date,'preparing');
insert into public.encounter_players(encounter_id,player_id)
values('00000000-0000-4000-8000-000000000403','00000000-0000-4000-8000-000000000402');
select public.set_prediction_deadline('00000000-0000-4000-8000-000000000403',now()-interval '1 minute');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000401","role":"authenticated","app_metadata":{"role":"participant"},"amr":[{"method":"password"}]}',true);
do $$ begin
  begin
    insert into public.predictions(encounter_id,user_id,predicted_player_id)
    values('00000000-0000-4000-8000-000000000403','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000402');
    raise exception 'Palpite após prazo foi aceito';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000401","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',true);
select public.set_prediction_deadline('00000000-0000-4000-8000-000000000403',null);
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000401","role":"authenticated","app_metadata":{"role":"participant"},"amr":[{"method":"password"}]}',true);
insert into public.predictions(encounter_id,user_id,predicted_player_id)
values('00000000-0000-4000-8000-000000000403','00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000402');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000401","role":"authenticated","app_metadata":{"role":"admin"},"amr":[{"method":"password"}]}',true);
select public.activate_encounter('00000000-0000-4000-8000-000000000403');
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000401","role":"authenticated","app_metadata":{"role":"participant"},"amr":[{"method":"password"}]}',true);
do $$ begin
  begin
    update public.predictions set predicted_player_id='00000000-0000-4000-8000-000000000402'
      where encounter_id='00000000-0000-4000-8000-000000000403';
    raise exception 'Palpite tardio foi aceito';
  exception when insufficient_privilege then null;
  end;
end $$;
select 'privacy_smoke_passed' as resultado;
rollback;
