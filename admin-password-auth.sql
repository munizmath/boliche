-- Execute depois de schema.sql. Restringe operações administrativas a
-- sessões autenticadas com senha; links de recuperação não bastam.
create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    and (auth.jwt() -> 'amr') @> '[{"method":"password"}]'::jsonb,
    false
  );
$$;
