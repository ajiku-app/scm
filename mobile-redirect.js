// HP (lebar <=640px) otomatis dibuka di tampilan khusus mobile /m.html
(function () {
  if (/desktop=1/.test(location.search)) sessionStorage.setItem('scm_desktop', '1');
  if (window.matchMedia('(max-width:640px)').matches && !sessionStorage.getItem('scm_desktop')) location.replace('/welcome.html');
})();
