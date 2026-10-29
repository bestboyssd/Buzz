import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import { initializeNativeApp } from './lib/capacitor';

// Register Workbox Service Worker for offline resilience & API/static caching
registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    console.debug('Workbox Service Worker registered:', swUrl);
    if (registration) {
      registration.update().catch(() => {});
    }
    if ('caches' in window) {
      caches.keys().then((keys) => {
        keys.forEach((key) => {
          if (key.startsWith('workbox-precache')) {
            caches.open(key).then((cache) => {
              cache.keys().then((requests) => {
                requests.forEach((req) => {
                  if (req.url.includes('index.html')) {
                    cache.delete(req);
                  }
                });
              });
            });
          }
        });
      }).catch(() => {});
    }
  },
  onOfflineReady() {
    console.debug('App is cached and ready to work offline.');
  },
});

// Initialize native features early
initializeNativeApp();

const shouldSuppressLog = (args: any[]) => {
  const first = typeof args[0] === 'string' ? args[0] : String(args[0]?.message || '');
  return (
    first.includes('update time that is in the future') ||
    first.includes('The width(-1) and height(-1) of chart should be greater than 0') ||
    first.includes('WebSocket closed without opened') ||
    first.includes('failed to connect to websocket')
  );
};

const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  if (shouldSuppressLog(args)) return;
  originalConsoleError(...args);
};

const originalConsoleWarn = console.warn;
console.warn = (...args: any[]) => {
  if (shouldSuppressLog(args)) return;
  originalConsoleWarn(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
