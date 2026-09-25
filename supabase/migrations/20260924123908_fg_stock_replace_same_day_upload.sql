create or replace function public.fg_stock_replace_same_day_upload()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.upload_date is null then
    return new;
  end if;

  delete from public.fg_stock_items
  where upload_id in (
    select id from public.fg_stock_uploads
    where upload_date = new.upload_date and id <> new.id
  );

  delete from public.fg_stock_uploads
  where upload_date = new.upload_date and id <> new.id;

  return new;
end;
$$;

revoke all on function public.fg_stock_replace_same_day_upload() from public, anon, authenticated;

drop trigger if exists trg_fg_stock_replace_same_day on public.fg_stock_uploads;
create trigger trg_fg_stock_replace_same_day
after insert on public.fg_stock_uploads
for each row execute function public.fg_stock_replace_same_day_upload();
