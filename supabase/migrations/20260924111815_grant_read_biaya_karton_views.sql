-- View biaya per karton bersifat security_invoker, jadi user login butuh akses baca ke view dan tabel target
grant select on public.target_biaya_karton to authenticated;

drop policy if exists target_biaya_karton_select on public.target_biaya_karton;
create policy target_biaya_karton_select
  on public.target_biaya_karton
  for select
  to authenticated
  using (true);

grant select on public.v_biaya_per_karton to authenticated;
grant select on public.v_biaya_per_karton_harian to authenticated;
grant select on public.v_biaya_per_karton_ringkas to authenticated;
