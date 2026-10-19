// Applies the saved theme before the first paint (an external file: the CSP allows no inline scripts).
try {
  var t = localStorage.getItem('cb.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
