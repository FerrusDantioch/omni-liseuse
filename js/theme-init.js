(function () {
  'use strict';
  var THEME_COLORS = { clair: '#faf0e6', sombre: '#1a1a1a', nuit: '#14111d' };

  try {
    var theme = localStorage.getItem('omni-liseuse-theme');
    if (theme === 'clair' || theme === 'sombre' || theme === 'nuit') {
      document.documentElement.dataset.theme = theme;
      var meta = document.getElementById('metaThemeColor');
      if (meta) meta.content = THEME_COLORS[theme];
    }

    var rawWarmth = localStorage.getItem('omni-liseuse-warmth');
    if (rawWarmth !== null) {
      var parsed = parseInt(rawWarmth, 10);
      if (!isNaN(parsed)) {
        var warmth = Math.min(45, Math.max(0, parsed));
        var rootStyle = document.documentElement.style;
        rootStyle.setProperty('--warmth-opacity', String(warmth / 100));
        rootStyle.setProperty('--warmth-visibility', warmth > 0 ? 'visible' : 'hidden');
      }
    }
  } catch (_) {
    /* Le thème et le filtre chaud seront appliqués après le chargement des réglages. */
  }
}());
