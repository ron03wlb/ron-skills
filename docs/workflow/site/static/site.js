(() => {
  const toggle = document.querySelector('.sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;
  const set = (open) => { document.body.classList.toggle('sidebar-open', open); toggle.setAttribute('aria-expanded', String(open)); };
  toggle.addEventListener('click', () => set(!document.body.classList.contains('sidebar-open')));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') set(false); });
  sidebar.addEventListener('click', (event) => { if (event.target.closest('a') && matchMedia('(max-width: 900px)').matches) set(false); });
})();
