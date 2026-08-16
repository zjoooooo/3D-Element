import { App } from './core/App.js';
import { LoadingScreen } from './ui/HUD.js';

/**
 * Entry point.
 *
 * Everything interesting lives in `core/App.js`; this file only wires the app
 * to the page and reports fatal boot errors somewhere the user can see them.
 *
 * `window.__gateOk` is index.html's inline pre-boot script (M5 Task 13):
 * false means it already swapped the whole page for the WebGL2/desktop gate
 * message (`.fatal-overlay` in styles.css) — #viewport is gone, so nothing
 * below may run.
 */
if (window.__gateOk) {
  const canvas = document.getElementById('viewport');

  // The sandbox/run split is decided once, at App construction, off `#run` in
  // the URL — so typing the hash into an already-open page must reload, or
  // nothing changes and the switch silently looks broken.
  window.addEventListener('hashchange', () => location.reload());

  const boot = async () => {
    try {
      const app = new App(canvas);
      await app.load();

      // Handy for poking at the scene from the console.
      window.app = app;
    } catch (error) {
      console.error('[boot] failed to start', error);
      new LoadingScreen().fail(
        error?.message ? `Failed to start: ${error.message}` : 'Failed to start — see the console.'
      );
    }
  };

  boot();
}
