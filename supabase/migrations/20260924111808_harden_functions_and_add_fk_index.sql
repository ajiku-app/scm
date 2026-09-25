-- Fungsi trigger tidak perlu bisa dipanggil lewat /rest/v1/rpc oleh anon/authenticated
revoke execute on function public.prevent_role_self_escalation() from public, anon, authenticated;
revoke execute on function public.reject_anonymous_signup() from public, anon, authenticated;

-- Kunci search_path
alter function public.prevent_role_self_escalation() set search_path = public, pg_temp;
alter function public.parse_tgl_fleksibel(text) set search_path = '';

-- Index untuk foreign key yang belum punya
create index if not exists fg_stock_uploads_uploaded_by_idx on public.fg_stock_uploads (uploaded_by);

-- Tabel backup tidak perlu diakses lewat API
revoke all on table public.logistics_tgl_backup_20260924 from anon, authenticated;
