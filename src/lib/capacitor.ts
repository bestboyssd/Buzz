import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { Capacitor } from '@capacitor/core';
import { Keyboard } from '@capacitor/keyboard';
import { triggerHaptic } from './haptics';

let isInitialized = false;

export const updateStatusBarTheme = async (isDark: boolean) => {
  // Update browser/WebView theme-color meta tag in both web and native Android
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', isDark ? '#020617' : '#f8fafc');
  }

  if (Capacitor.isNativePlatform()) {
    try {
      await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
      await StatusBar.setBackgroundColor({ color: isDark ? '#020617' : '#f8fafc' });
    } catch (e) {
      console.debug('Status bar colors could not be set', e);
    }
  }
};

export const initializeNativeApp = async () => {
  if (isInitialized) return;
  isInitialized = true;

  // Automatically observe dark/light theme changes on <html> so Android StatusBar stays in sync
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    const htmlEl = document.documentElement;
    const syncTheme = () => {
      const isDark = htmlEl.classList.contains('dark');
      updateStatusBarTheme(isDark);
    };
    syncTheme();

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.attributeName === 'class') {
          syncTheme();
          break;
        }
      }
    });
    observer.observe(htmlEl, { attributes: true, attributeFilter: ['class'] });
  }

  if (!Capacitor.isNativePlatform()) return;

  try {
    // 1. Edge-to-edge WebView overlay under status bar notch
    await StatusBar.setOverlaysWebView({ overlay: true });

    const isDark =
      document.documentElement.classList.contains('dark') ||
      localStorage.getItem('theme') === 'dark';
    await updateStatusBarTheme(isDark);

    // 2. Smooth SplashScreen hide after initial React frame renders
    setTimeout(async () => {
      try {
        await SplashScreen.hide({ fadeOutDuration: 250 });
      } catch (splashErr) {
        console.debug('SplashScreen.hide bypassed:', splashErr);
      }
    }, 300);

    // 3. Native Android Keyboard lifecycle management
    try {
      Keyboard.addListener('keyboardWillShow', (info) => {
        const height = info?.keyboardHeight || 0;
        document.documentElement.style.setProperty('--keyboard-inset-height', `${height}px`);
        document.documentElement.classList.add('keyboard-open');
        window.dispatchEvent(new CustomEvent('nativeKeyboardStateChanged', { detail: { isOpen: true, height } }));
      });

      Keyboard.addListener('keyboardDidShow', (info) => {
        const height = info?.keyboardHeight || 0;
        document.documentElement.style.setProperty('--keyboard-inset-height', `${height}px`);
        document.documentElement.classList.add('keyboard-open');
        window.dispatchEvent(new CustomEvent('nativeKeyboardStateChanged', { detail: { isOpen: true, height } }));
      });

      Keyboard.addListener('keyboardWillHide', () => {
        document.documentElement.style.setProperty('--keyboard-inset-height', '0px');
        document.documentElement.classList.remove('keyboard-open');
        window.dispatchEvent(new CustomEvent('nativeKeyboardStateChanged', { detail: { isOpen: false, height: 0 } }));
      });

      Keyboard.addListener('keyboardDidHide', () => {
        document.documentElement.style.setProperty('--keyboard-inset-height', '0px');
        document.documentElement.classList.remove('keyboard-open');
        window.dispatchEvent(new CustomEvent('nativeKeyboardStateChanged', { detail: { isOpen: false, height: 0 } }));
      });
    } catch (kbErr) {
      console.debug('Keyboard listener registration bypassed:', kbErr);
    }

    // 4. App foreground/background lifecycle sync
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        const currentDark =
          document.documentElement.classList.contains('dark') ||
          localStorage.getItem('theme') === 'dark';
        updateStatusBarTheme(currentDark);
        window.dispatchEvent(new CustomEvent('appResumed'));
      }
    });

    // 5. Intelligent Layered Android Hardware Back Button & Gesture Navigation Handler
    let lastBackPressTime = 0;
    App.addListener('backButton', ({ canGoBack }) => {
      // Layer A: If an input or textarea is focused, blur it and hide keyboard first
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.isContentEditable)
      ) {
        activeEl.blur();
        return;
      }

      // Layer B: Allow open modals/drawers (e.g., Buzz AI drawer, Receipt modals) to intercept & close
      const backEvent = new CustomEvent('androidBackPress', { cancelable: true });
      const notCancelled = window.dispatchEvent(backEvent);
      if (!notCancelled) {
        triggerHaptic('soft');
        return;
      }

      // Layer C: If on a secondary root tab, navigate smoothly back to Home POS ('/') first
      const path = window.location.pathname;
      const secondaryTabs = ['/products', '/checkout', '/history', '/settings'];
      if (secondaryTabs.includes(path)) {
        triggerHaptic('selection');
        window.history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
        return;
      }

      // Layer D: On Home ('/') or when history cannot go back, require double-press within 2s to exit app
      if (path === '/' || !canGoBack) {
        const now = Date.now();
        if (now - lastBackPressTime < 2000) {
          App.exitApp();
        } else {
          lastBackPressTime = now;
          triggerHaptic('light');
          window.dispatchEvent(new CustomEvent('showExitToast'));
        }
      } else {
        triggerHaptic('soft');
        window.history.back();
      }
    });
  } catch (e) {
    console.warn('Native capabilities not available or failed to initialize', e);
  }
};
