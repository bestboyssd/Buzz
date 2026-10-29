import { auth } from './firebase';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

export type HapticType =
  | 'light'
  | 'medium'
  | 'heavy'
  | 'success'
  | 'warning'
  | 'error'
  | 'rigid'
  | 'soft'
  | 'selection';

let sharedAudioCtx: AudioContext | null = null;
let lastHapticTimestamp = 0;

function getTactileAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!sharedAudioCtx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        sharedAudioCtx = new AudioCtx();
      }
    }
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

/**
 * Synthesizes a subtle, ultra-short physical switch micro-impulse via Web Audio API.
 * Provides tactile sensation on iOS Safari, desktop, and webviews where navigator.vibrate is silent.
 */
function playTactileMicroImpulse(type: HapticType) {
  const ctx = getTactileAudioContext();
  if (!ctx || ctx.state !== 'running') return;

  try {
    const now = ctx.currentTime;

    const triggerPulse = (
      freqStart: number,
      freqEnd: number,
      durationSec: number,
      gainPeak: number,
      offsetSec = 0,
      wave: OscillatorType = 'sine'
    ) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = wave;
      osc.frequency.setValueAtTime(freqStart, now + offsetSec);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + offsetSec + durationSec);

      gain.gain.setValueAtTime(0.0001, now + offsetSec);
      gain.gain.linearRampToValueAtTime(gainPeak, now + offsetSec + 0.0015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offsetSec + durationSec);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + offsetSec);
      osc.stop(now + offsetSec + durationSec + 0.002);
    };

    switch (type) {
      case 'soft':
      case 'selection':
        triggerPulse(180, 75, 0.006, 0.025, 0, 'sine');
        break;
      case 'light':
        triggerPulse(210, 85, 0.008, 0.038, 0, 'sine');
        break;
      case 'rigid':
        triggerPulse(280, 110, 0.007, 0.05, 0, 'triangle');
        break;
      case 'medium':
        triggerPulse(165, 65, 0.011, 0.055, 0, 'triangle');
        break;
      case 'heavy':
        triggerPulse(135, 48, 0.015, 0.075, 0, 'triangle');
        break;
      case 'success':
        triggerPulse(240, 160, 0.01, 0.045, 0, 'sine');
        triggerPulse(360, 260, 0.014, 0.055, 0.055, 'sine');
        break;
      case 'warning':
        triggerPulse(190, 110, 0.012, 0.05, 0, 'triangle');
        triggerPulse(170, 95, 0.012, 0.05, 0.07, 'triangle');
        break;
      case 'error':
        triggerPulse(140, 60, 0.016, 0.065, 0, 'sawtooth');
        triggerPulse(115, 50, 0.018, 0.065, 0.065, 'sawtooth');
        break;
    }
  } catch {
    // Ignore audio context restrictions
  }
}

export const triggerHaptic = (type: HapticType = 'light') => {
  const now = Date.now();
  // Prevent overlapping rapid-fire vibrations within 16ms frame
  if (now - lastHapticTimestamp < 16 && (type === 'light' || type === 'soft' || type === 'selection')) {
    return;
  }
  lastHapticTimestamp = now;

  const user = auth.currentUser;
  const storageKey = user ? `hapticsEnabled_${user.uid}` : 'hapticsEnabled';
  const isHapticsEnabled = localStorage.getItem(storageKey) !== 'false';
  if (!isHapticsEnabled) return;

  // 1. Native Capacitor Haptics Engine
  if (Capacitor.isNativePlatform()) {
    try {
      switch (type) {
        case 'soft':
          Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
          break;
        case 'selection':
          Haptics.selectionChanged().catch(() => {});
          break;
        case 'light':
        case 'rigid':
          Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
          break;
        case 'medium':
          Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
          break;
        case 'heavy':
          Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
          break;
        case 'success':
          Haptics.notification({ type: NotificationType.Success }).catch(() => {});
          break;
        case 'warning':
          Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
          break;
        case 'error':
          Haptics.notification({ type: NotificationType.Error }).catch(() => {});
          break;
      }
      return;
    } catch {
      // Fall through to web haptics
    }
  }

  // 2. Refined Web Vibration API Cadences
  let vibrated = false;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      switch (type) {
        case 'soft':
          vibrated = navigator.vibrate(4);
          break;
        case 'selection':
          vibrated = navigator.vibrate(6);
          break;
        case 'light':
          vibrated = navigator.vibrate(8);
          break;
        case 'rigid':
          vibrated = navigator.vibrate(14);
          break;
        case 'medium':
          vibrated = navigator.vibrate(20);
          break;
        case 'heavy':
          vibrated = navigator.vibrate([28, 16, 14]);
          break;
        case 'success':
          vibrated = navigator.vibrate([12, 24, 32]);
          break;
        case 'warning':
          vibrated = navigator.vibrate([24, 32, 24]);
          break;
        case 'error':
          vibrated = navigator.vibrate([45, 30, 45, 30, 45]);
          break;
      }
    } catch {
      vibrated = false;
    }
  }

  // 3. Subtle Web Audio API Tactile Micro-Impulse Synthesis
  // Always accompanies or falls back when device lacks physical vibration motor
  if (!vibrated || typeof window !== 'undefined') {
    playTactileMicroImpulse(type);
  }
};
