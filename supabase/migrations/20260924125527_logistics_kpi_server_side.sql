-- View durasi loading per trip. security_invoker = RLS tabel logistics tetap berlaku.
create or replace view public.v_logistics_trip
with (security_invoker = true) as
with base as (
  select l.*,
    case
      when l.time_in  ~ '^\d{1,2}:\d{2}$'
       and l.time_out ~ '^\d{1,2}:\d{2}$'
      then (split_part(l.time_out,':',1)::int*60 + split_part(l.time_out,':',2)::int)
         - (split_part(l.time_in ,':',1)::int*60 + split_part(l.time_in ,':',2)::int)
    end as durasi_menit
  from public.logistics l
)
select id, tgl_date, driver, no_mobil, ekspedisi, armada, provinsi, kota,
       time_in, time_out, jadwal_out,
       durasi_menit,
       (durasi_menit is not null and durasi_menit >= 0) as durasi_valid
from base;

comment on view public.v_logistics_trip is
'Durasi loading per trip (menit) dari time_in/time_out. durasi_valid=false untuk format salah atau time_out < time_in (anomali data, dikeluarkan dari KPI).';

-- KPI dihitung di server: tidak terkena batas 1000 baris PostgREST.
create or replace function public.get_logistics_kpi(
  p_from date default null,
  p_to date default null,
  p_sla_menit int default 90
) returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with t as (
  select * from public.v_logistics_trip
  where (p_from is null or tgl_date >= p_from)
    and (p_to   is null or tgl_date <= p_to)
),
agg as (
  select
    count(*)                                             as total_trip,
    count(*) filter (where durasi_valid)                 as trip_valid,
    count(*) filter (where not durasi_valid)             as trip_anomali,
    count(*) filter (where durasi_valid and durasi_menit <= p_sla_menit) as dalam_sla,
    count(*) filter (where durasi_valid and durasi_menit >  p_sla_menit) as lewat_sla,
    round(avg(durasi_menit) filter (where durasi_valid), 1)              as avg_menit,
    percentile_cont(0.5) within group (order by durasi_menit) filter (where durasi_valid) as median_menit,
    percentile_cont(0.9) within group (order by durasi_menit) filter (where durasi_valid) as p90_menit,
    count(distinct nullif(trim(ekspedisi),''))           as ekspedisi_aktif,
    count(*) filter (where nullif(trim(jadwal_out),'') is not null) as jadwal_out_terisi
  from t
),
terlama as (
  select jsonb_build_object('id',id,'tgl',tgl_date,'driver',trim(driver),'ekspedisi',ekspedisi,
                            'armada',armada,'provinsi',provinsi,'kota',trim(kota),
                            'durasi_menit',durasi_menit) as j
  from t where durasi_valid order by durasi_menit desc limit 1
),
per_armada as (
  select coalesce(jsonb_agg(x order by x->>'armada'), '[]'::jsonb) as j from (
    select jsonb_build_object(
      'armada', coalesce(armada,'-'),
      'trip', count(*),
      'sla_pct', round(100.0 * count(*) filter (where durasi_menit <= p_sla_menit) / nullif(count(*),0), 1),
      'avg_menit', round(avg(durasi_menit),1),
      'median_menit', percentile_cont(0.5) within group (order by durasi_menit)
    ) as x
    from t where durasi_valid group by armada
  ) s
),
vol as (
  select
    count(distinct (s.tanggal_posting, s.no_mobil)) as kendaraan,
    sum(s.qty * coalesce(m.volume_produk,0))        as total_m3
  from public.shipments s
  join public.master_produk m on m.kode_sku = s.kode_sku
  where nullif(trim(s.no_mobil),'') is not null
    and (p_from is null or s.tanggal_posting >= p_from)
    and (p_to   is null or s.tanggal_posting <= p_to)
)
select jsonb_build_object(
  'sla_target_menit', p_sla_menit,
  'total_trip',   agg.total_trip,
  'trip_valid',   agg.trip_valid,
  'trip_anomali', agg.trip_anomali,
  'lewat_sla',    agg.lewat_sla,
  'sla_pct',      round(100.0 * agg.dalam_sla / nullif(agg.trip_valid,0), 1),
  'avg_menit',    agg.avg_menit,
  'median_menit', agg.median_menit,
  'p90_menit',    agg.p90_menit,
  'ekspedisi_aktif', agg.ekspedisi_aktif,
  'loading_terlama', (select j from terlama),
  -- NULL (bukan 0) bila data sumber memang belum ada, supaya UI bisa tampil "—"
  'jadwal_out_terisi', agg.jadwal_out_terisi,
  'tunggu_driver_menit', null,
  'kendaraan_bervolume', vol.kendaraan,
  'volume_per_kendaraan_m3', case when vol.kendaraan > 0 then round(vol.total_m3 / vol.kendaraan, 2) end,
  'per_armada', (select j from per_armada)
)
from agg, vol;
$$;

revoke all on function public.get_logistics_kpi(date,date,int) from public, anon;
grant execute on function public.get_logistics_kpi(date,date,int) to authenticated;
grant select on public.v_logistics_trip to authenticated;
revoke all on public.v_logistics_trip from anon;
