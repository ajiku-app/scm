-- Tutup kebocoran data lewat view yang berjalan dengan hak pemilik (postgres).
--
-- Temuan audit 21 Sep 2026: lima view di bawah tidak memakai security_invoker (semua view
-- lain di project ini memakainya) dan role `anon` boleh SELECT. Akibatnya view melewati RLS
-- tabel dasarnya: v_durasi_bongkar_muat mengembalikan seluruh 692 baris logistics (nama driver,
-- plat kendaraan) ke siapa pun yang memegang anon key, padahal tabel logistics sendiri tertutup.
-- v_biaya_harian_gudang akan membuka data upah begitu biaya_tenaga_harian terisi.
--
-- Edge Function memakai service role sehingga tidak terpengaruh. Bila ada aplikasi lain yang
-- membaca view ini langsung dengan anon key, ia akan berhenti bekerja; itu memang tujuannya.

alter view public.v_durasi_bongkar_muat         set (security_invoker = true);
alter view public.v_durasi_harian               set (security_invoker = true);
alter view public.v_durasi_ringkas              set (security_invoker = true);
alter view public.v_biaya_harian_gudang         set (security_invoker = true);
alter view public.v_estimasi_biaya_bulan_depan  set (security_invoker = true);

-- Data tingkat trip (driver, plat) dan upah tidak perlu terbaca anon sama sekali.
revoke select on public.v_durasi_bongkar_muat, public.v_biaya_harian_gudang from anon;
