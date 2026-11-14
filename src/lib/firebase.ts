import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
  doc,
  getDocFromServer,
  setLogLevel,
  enableNetwork,
  disableNetwork,
} from 'firebase/firestore';
import { triggerHaptic } from './haptics';
import appletConfig from '../../firebase-applet-config.json';
import { Capacitor } from '@capacitor/core';

// Always use the shared cloud Firestore database across PC Web Preview, PWA, and Native Android APKs
// so products, bills, other_costs, security_alerts, and user accounts sync across all devices in real time.
export const USE_PRODUCTION_DB_IN_DEV = true;

const isNativeAndroid = Capacitor.isNativePlatform();

// Native Android uses google-services.json (buzz-8521 Web Client ID) for native Google Sign-In;
// Web uses the provisioned applet OAuth client ID.
export const GOOGLE_CLIENT_ID = isNativeAndroid
  ? '327146649300-b186rkv6aj4la2fco79adj10smbrr8b2.apps.googleusercontent.com'
  : appletConfig.oAuthClientId ||
    '1080691680431-aop4epc4mvhp4den0thrlv17pt3op6rt.apps.googleusercontent.com';

// Shared Firestore database config used by ALL platforms (PC + Mobile APK)
const sharedDatabaseConfig = {
  projectId: appletConfig.projectId || 'tidy-byte-g5xj8',
  appId: appletConfig.appId,
  apiKey: appletConfig.apiKey,
  authDomain: appletConfig.authDomain,
  firestoreDatabaseId:
    appletConfig.firestoreDatabaseId ||
    'ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b',
  storageBucket: appletConfig.storageBucket,
  messagingSenderId: appletConfig.messagingSenderId,
};

// Native Android Auth config matching android/app/google-services.json so native Google Sign-In tokens verify cleanly
const nativeAuthConfig = {
  projectId: 'buzz-8521',
  appId: '1:327146649300:web:3504c5ae7c9ebb5381ed41',
  apiKey: 'AIzaSyBA7uwlJHyHU6Q2PN2K271-WrbHGrNJG8Q',
  authDomain: 'buzz-8521.firebaseapp.com',
  storageBucket: 'buzz-8521.firebasestorage.app',
  messagingSenderId: '327146649300',
};

export const app = initializeApp(sharedDatabaseConfig);
const authApp = isNativeAndroid
  ? initializeApp(nativeAuthConfig, 'native-android-auth')
  : app;

// Synchronously initialize Firestore with multi-tab IndexedDB persistence.
// On Native Android WebViews, force HTTP long-polling so writes/reads never stall on WebChannel stream probes.
export const db = (() => {
  try {
    return initializeFirestore(
      app,
      {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
        ...(isNativeAndroid
          ? { experimentalForceLongPolling: true }
          : { experimentalAutoDetectLongPolling: true }),
      },
      sharedDatabaseConfig.firestoreDatabaseId
    );
  } catch (e) {
    console.warn('Fallback to existing Firestore instance:', e);
    return getFirestore(app, sharedDatabaseConfig.firestoreDatabaseId);
  }
})();

export const auth = getAuth(authApp);
setLogLevel('error'); // Suppress warnings about future timestamps caused by mock clock

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
