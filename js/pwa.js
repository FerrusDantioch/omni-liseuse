export async function initPwa({ onBeforeApplyUpdate, onLaunchFiles } = {}) {
  const byId = id => document.getElementById(id);
  const updateBanner = byId('updateBanner');
  const updateButton = byId('updateButton');
  const updateDismissButton = byId('updateDismissButton');
  const installButton = byId('installButton');
  const pwaStatus = byId('pwaStatus');

  let waitingWorker = null;
  let deferredInstallPrompt = null;

  function offerUpdate(worker) {
    if (!worker) return;
    waitingWorker = worker;
    if (updateButton) updateButton.disabled = false;
    if (updateBanner) updateBanner.hidden = false;
  }

  updateButton?.addEventListener('click', async () => {
    if (!waitingWorker) return;
    updateButton.disabled = true;
    try {
      await onBeforeApplyUpdate?.();
    } catch (_) {}
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });

  updateDismissButton?.addEventListener('click', () => {
    if (updateBanner) updateBanner.hidden = true;
  });

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installButton) installButton.hidden = false;
  });

  installButton?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } catch (_) {}
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installButton) installButton.hidden = true;
  });

  if ('launchQueue' in window && typeof window.launchQueue?.setConsumer === 'function') {
    window.launchQueue.setConsumer(async launchParams => {
      const handles = launchParams?.files;
      if (!Array.isArray(handles) || !handles.length) return;
      const files = [];
      for (const handle of handles) {
        try {
          if (typeof handle?.getFile === 'function') {
            files.push(await handle.getFile());
          } else if (handle instanceof File) {
            files.push(handle);
          }
        } catch (_) {}
      }
      if (files.length) {
        await onLaunchFiles?.(files);
      }
    });
  }

  const secure =
    location.protocol === 'https:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  if (!('serviceWorker' in navigator) || !secure) {
    if (pwaStatus) {
      pwaStatus.textContent =
        'Tes livres et tes positions restent enregistrés sur cet appareil. ' +
        'Le mode hors ligne nécessite une adresse https://.';
    }
    return;
  }

  let hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    if (reloading) return;
    reloading = true;
    try {
      await onBeforeApplyUpdate?.();
    } catch (_) {}
    location.reload();
  });

  const UPDATE_CHECK_COOLDOWN_MS = 5 * 60 * 1000;
  let lastUpdateCheck = 0;

  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js', {
      updateViaCache: 'none'
    });

    if (registration.waiting && navigator.serviceWorker.controller) {
      offerUpdate(registration.waiting);
    }

    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          offerUpdate(worker);
        }
      });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      const now = Date.now();
      if (now - lastUpdateCheck < UPDATE_CHECK_COOLDOWN_MS) return;
      lastUpdateCheck = now;
      registration.update().catch(() => {});
    });

    await navigator.serviceWorker.ready;
    if (pwaStatus) {
      pwaStatus.textContent =
        'Application disponible hors ligne. Tes livres et tes positions sont enregistrés sur cet appareil.';
    }
  } catch (error) {
    console.warn('Service worker non enregistré :', error);
    if (pwaStatus) {
      pwaStatus.textContent =
        'Mode hors ligne indisponible ; tes livres restent enregistrés sur cet appareil.';
    }
  }
}
