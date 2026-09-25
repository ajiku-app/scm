set local search_path to public;

-- 1. Hapus policy duplikat (perilaku efektif tetap sama karena policy permissive digabung dengan OR)
drop policy if exists "Public insert access authenticated" on public.logistics;   -- duplikat logistics_write_authenticated
drop policy if exists "Public read access authenticated" on public.logistics;     -- duplikat logistics_select_authenticated
drop policy if exists profiles_select_own on public.profiles;                     -- sudah tercakup profiles_select_own_or_admin
drop policy if exists "user writes own face" on public.fg_face_enrollment;        -- tercakup face_enrollment_owner_only (ALL)
drop policy if exists "user reads own face" on public.fg_face_enrollment;
drop policy if exists "user updates own face" on public.fg_face_enrollment;

-- 2. Bungkus auth.uid()/auth.jwt() dengan (select ...) agar dievaluasi sekali per query, bukan per baris
do $$
declare
  r record;
  q text;
  w text;
  stmt text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ 'auth\.(uid|jwt)\(\)' or coalesce(with_check, '') ~ 'auth\.(uid|jwt)\(\)')
      and coalesce(qual, '') !~* 'select auth\.'
      and coalesce(with_check, '') !~* 'select auth\.'
  loop
    q := case when r.qual is null then null
              else replace(replace(r.qual, 'auth.uid()', '(select auth.uid())'), 'auth.jwt()', '(select auth.jwt())') end;
    w := case when r.with_check is null then null
              else replace(replace(r.with_check, 'auth.uid()', '(select auth.uid())'), 'auth.jwt()', '(select auth.jwt())') end;
    stmt := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if q is not null then stmt := stmt || ' using (' || q || ')'; end if;
    if w is not null then stmt := stmt || ' with check (' || w || ')'; end if;
    execute stmt;
  end loop;
end $$;
