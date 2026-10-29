import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { auth } from './firebase';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const MAX_BILL_AMOUNT = 10000;
export const MAX_PRODUCT_STOCK = 2000;

export function formatPrice(price: number | string | undefined | null): string {
  if (price === undefined || price === null || price === '') {
    return '0';
  }
  const cleaned = typeof price === 'string' ? price.replace(/[^0-9.-]/g, '') : price;
  const num = Number(cleaned);
  if (Number.isNaN(num)) {
    return '0';
  }
  if (!Number.isFinite(num)) {
    return num > 0 ? MAX_BILL_AMOUNT.toString() : '0';
  }
  const safeNum = Math.max(0, num);
  if (Number.isInteger(safeNum)) {
    return safeNum.toString();
  }
  return safeNum.toFixed(2).replace(/\.00$/, '');
}

const recentNotificationsMemory = new Map<string, number>();
const DEDUPE_WINDOW_MS = 4000;
let notificationSeqCounter = 0;
let channelInitialized = false;
let notificationQueuePromise: Promise<void> = Promise.resolve();

const HIGH_PRIORITY_CHANNEL_ID = 'buzz_pos_alerts_high_v3';

export const ensureNotificationChannel = async () => {
    if (channelInitialized) return;
    if (!Capacitor.isNativePlatform()) {
        channelInitialized = true;
        return;
    }
    try {
        await LocalNotifications.createChannel({
            id: HIGH_PRIORITY_CHANNEL_ID,
            name: 'Buzz POS Alerts & Stock Warnings',
            description: 'Low stock, out of stock, security warnings, and admin broadcasts',
            importance: 5, // IMPORTANCE_HIGH (heads-up banner + sound + wake screen)
            visibility: 1, // VISIBILITY_PUBLIC (show on lock screen)
            vibration: true,
            lights: true,
            sound: 'default',
        });
        channelInitialized = true;
    } catch (e) {
        console.debug('Notification channel creation skipped:', e);
    }
};

function getUniqueNotificationId(key: string): number {
    notificationSeqCounter = (notificationSeqCounter + 1) % 10000;
    let hash = 0;
    const saltedKey = `${key}::${Date.now()}::${notificationSeqCounter}`;
    for (let i = 0; i < saltedKey.length; i++) {
        hash = (hash * 31 + saltedKey.charCodeAt(i)) | 0;
    }
    return (Math.abs(hash) % 800000000) + 10000 + notificationSeqCounter;
}

export const showLocalNotification = async (
    title: string,
    body: string,
    icon?: string,
    dedupeTag?: string
) => {
    try {
        const user = auth.currentUser;
        const storageKey = user ? `notifications_${user.uid}` : 'notifications';
        const notificationsEnabled = localStorage.getItem(storageKey) !== 'false';
        if (!notificationsEnabled) {
            return;
        }

        const key = dedupeTag || `${title.trim()}::${body.trim()}`;
        const now = Date.now();
        const memLast = recentNotificationsMemory.get(key) || 0;
        if (now - memLast < DEDUPE_WINDOW_MS) {
            return;
        }

        const storageDedupeKey = `notif_dedupe_${key.slice(0, 140)}`;
        const storedLast = parseInt(localStorage.getItem(storageDedupeKey) || '0', 10);
        if (now - storedLast < DEDUPE_WINDOW_MS) {
            recentNotificationsMemory.set(key, storedLast);
            return;
        }

        recentNotificationsMemory.set(key, now);
        try {
            localStorage.setItem(storageDedupeKey, String(now));
        } catch {}

        const deliverWebNotification = async (uniqueTag: string) => {
            if (!('Notification' in window)) return;
            const postViaWeb = async () => {
                if ('serviceWorker' in navigator) {
                    try {
                        const reg =
                            (await navigator.serviceWorker.getRegistration()) ||
                            (await navigator.serviceWorker.ready);
                        if (reg && typeof reg.showNotification === 'function') {
                            await reg.showNotification(title, {
                                body,
                                icon: icon || '/pwa-192x192.png',
                                badge: '/pwa-192x192.png',
                                tag: uniqueTag,
                                renotify: true,
                                requireInteraction: false,
                                vibrate: [180, 80, 180],
                                data: { url: '/', timestamp: Date.now() },
                            } as any);
                            return;
                        }
                    } catch {}
                }
                new Notification(title, {
                    body,
                    icon: icon || '/pwa-192x192.png',
                    tag: uniqueTag,
                });
            };

            if (Notification.permission === 'granted') {
                await postViaWeb();
            } else if (Notification.permission !== 'denied') {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    await postViaWeb();
                }
            }
        };

        // Enqueue delivery sequentially with a 300ms spacing so Android & Browser never drop or collapse burst notifications
        notificationQueuePromise = notificationQueuePromise
            .then(async () => {
                const notifId = getUniqueNotificationId(key);
                const uniqueTag = `${key}_${notifId}`;

                if (Capacitor.isNativePlatform()) {
                    try {
                        const nativeExporter = (window as any).AndroidExporter;
                        if (nativeExporter && typeof nativeExporter.postNotification === 'function') {
                            const posted = nativeExporter.postNotification(notifId, title, body);
                            if (posted) {
                                await new Promise((resolve) => setTimeout(resolve, 300));
                                return;
                            }
                        }
                        await ensureNotificationChannel();
                        let { display } = await LocalNotifications.checkPermissions();
                        if (display !== 'granted') {
                            const req = await LocalNotifications.requestPermissions();
                            display = req.display;
                        }
                        if (display === 'granted') {
                            await LocalNotifications.schedule({
                                notifications: [
                                    {
                                        title,
                                        body,
                                        id: notifId,
                                        channelId: HIGH_PRIORITY_CHANNEL_ID,
                                        sound: 'default',
                                        extra: { tag: uniqueTag, timestamp: Date.now() },
                                    },
                                ],
                            });
                        } else {
                            await deliverWebNotification(uniqueTag);
                        }
                    } catch (nativeErr) {
                        console.warn('Native LocalNotifications failed, falling back to web notification:', nativeErr);
                        await deliverWebNotification(uniqueTag);
                    }
                } else {
                    await deliverWebNotification(uniqueTag);
                }

                await new Promise((resolve) => setTimeout(resolve, 300));
            })
            .catch((err) => {
                console.warn('Queued notification error:', err);
            });

        await notificationQueuePromise;
    } catch (e) {
        console.warn('Notification failed to show:', e);
    }
};

import { useReducedMotion } from 'motion/react';

export function useOptimizedTransition(customTransition?: any) {
    const shouldReduceMotion = useReducedMotion();
    if (shouldReduceMotion) {
        return {
            type: 'tween' as const,
            duration: 0
        };
    }
    return { type: 'spring' as const, stiffness: 350, damping: 25, mass: 0.8 };
}

export function useHardwareAcceleration() {
    return "transform-gpu will-change-transform";
}

/**
 * App-wide Business Day Cutoff (1:00 AM):
 * Because the shop sometimes closes at 12:00 AM midnight, timestamps between
 * 12:00 AM and 12:59:59 AM still count as "Today" (the shift that just ended).
 */
export function getAppBusinessDate(input: Date | number | string = new Date()): Date {
    const raw = input instanceof Date ? input : new Date(input);
    const valid = isNaN(raw.getTime()) ? new Date() : raw;
    // Shift back by 1 hour (3,600,000 ms) so 00:00–00:59 AM stays on the active shift day
    return new Date(valid.getTime() - 60 * 60 * 1000);
}

export function getAppBusinessIsoDate(input: Date | number | string = new Date()): string {
    const d = getAppBusinessDate(input);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Bills Cutoff (12:00 AM Midnight):
 * Billing stops around 11:30 PM, so bills use the standard 12:00 AM midnight
 * calendar boundary (00:00:00.000 to 23:59:59.999).
 */
export function getBillCalendarIsoDate(input: Date | number | string = new Date()): string {
    const raw = input instanceof Date ? input : new Date(input);
    const valid = isNaN(raw.getTime()) ? new Date() : raw;
    return `${valid.getFullYear()}-${String(valid.getMonth() + 1).padStart(2, '0')}-${String(valid.getDate()).padStart(2, '0')}`;
}

export function getDeviceId(): string {
    try {
        const key = 'buzz_pos_device_id_v1';
        let existing = localStorage.getItem(key);
        if (!existing) {
            existing = `dev_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem(key, existing);
        }
        return existing;
    } catch {
        return 'dev_fallback';
    }
}

export function markLocalSecurityAlertTriggered(alertId: string): void {
    if (!alertId) return;
    try {
        const key = 'local_triggered_security_alerts_v1';
        const raw = localStorage.getItem(key);
        const list: string[] = raw ? JSON.parse(raw) : [];
        const set = new Set(Array.isArray(list) ? list : []);
        set.add(String(alertId));
        localStorage.setItem(key, JSON.stringify(Array.from(set).slice(-100)));
    } catch {}
}

export function isLocalSecurityAlertTriggered(alertId?: string): boolean {
    if (!alertId) return false;
    try {
        const key = 'local_triggered_security_alerts_v1';
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const list: string[] = JSON.parse(raw);
        return Array.isArray(list) && list.includes(String(alertId));
    } catch {
        return false;
    }
}


