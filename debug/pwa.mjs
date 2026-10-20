// Browser test fixtures must never install or change the real app's worker.
if (window.top === window.self && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' })
      .catch(error => console.warn('CAN/LAB offline support could not start:', error));
  });
}
