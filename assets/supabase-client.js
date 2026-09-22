// assets/supabase-client.js
//
// Konfigurasi Supabase untuk BROWSER (login.html, enroll.html, auth-guard.js).
// SUPABASE_ANON_KEY di sini BUKAN rahasia: anon key memang dirancang untuk
// dipegang browser. Yang menjaga data adalah Row Level Security (RLS) di
// database, bukan kerahasiaan kunci ini. Ini beda dari SUPABASE_ANON_KEY di
// .env.local, yang dipakai server (api/*.js) untuk memanggil Edge Function
// dengan hak akses lebih luas (membaca view analisis) — itu tetap harus
// tersembunyi karena dikombinasikan dengan pengecekan login di server.
window.SCM_SUPABASE_URL = 'https://qbougldvlmceeqceduae.supabase.co';
window.SCM_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFib3VnbGR2bG1jZWVxY2VkdWFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NDQ3NzgsImV4cCI6MjEwNDEyMDc3OH0.10PDqnr2ShDbWwqNbt76EsMmeGgL5aOwETdYIov4g3s';

window.scmSupabase = window.supabase.createClient(
  window.SCM_SUPABASE_URL,
  window.SCM_SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'scm-auth' } }
);
