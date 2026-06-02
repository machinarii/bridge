/* Bridge — Electron preload. Exposes a tiny, safe bridge so the renderer can
 * drive window-level full screen instead of HTML element full screen. Window
 * full screen has no Chromium "press and hold Esc" notice and leaves Esc fully
 * under the app's control (so it can act as Back). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  toggleFullscreen: () => ipcRenderer.invoke('bridge:toggle-fullscreen'),
  isFullscreen:     () => ipcRenderer.invoke('bridge:is-fullscreen'),
  onFullscreenChange: (cb) => {
    const handler = (_e, value) => cb(!!value);
    ipcRenderer.on('bridge:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('bridge:fullscreen-changed', handler);
  },
});
