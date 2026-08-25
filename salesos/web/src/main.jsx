import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/ios.css';
import { isNativeShell } from './lib/server.js';
import App from './App.jsx';

/**
 * Register the service worker so the app is installable and its shell survives a
 * dropped connection. Production only: in development it would serve yesterday's
 * bundle from cache and make every change look like it did not apply.
 *
 * A service worker needs a secure context, so this is a no-op over plain HTTP on
 * a LAN address. The app still works and is still installable there; it just
 * has no offline shell.
 */
// Skipped in the native shell: the assets are already on the device inside the
// app bundle, so there is nothing for a worker to cache, and the capacitor://
// scheme is not one it can claim anyway.
if (import.meta.env.PROD && !isNativeShell() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
      console.warn('service worker registration failed', error);
    });
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
