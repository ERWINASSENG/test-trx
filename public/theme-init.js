(function () {
  try {
    var saved = localStorage.getItem('transimex_app_theme');
    var theme = saved === 'light' || saved === 'dark' ? saved : 'dark';
    var root = document.documentElement;

    if (theme === 'dark') {
      root.classList.add('dark');
      root.setAttribute('data-theme', 'dark');
    } else {
      root.classList.remove('dark');
      root.setAttribute('data-theme', 'light');
    }
  } catch (error) {
    // Theme initialization is optional when browser storage is unavailable.
  }
})();
