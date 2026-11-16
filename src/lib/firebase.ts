import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAnalytics, isSupported, type Analytics } from "firebase/analytics";

// Firebase web-app config — public by design (identifies the project, not a secret).
// The mobile app uses the same project via google-services.json; the backend
// sends FCM through src/lib/push.ts with the service account instead.
const firebaseConfig = {
  apiKey: "AIzaSyBwnKcymHTp7SzWnbjG-TWlAIxrHrWNEmI",
  authDomain: "zapnivo.firebaseapp.com",
  projectId: "zapnivo",
  storageBucket: "zapnivo.firebasestorage.app",
  messagingSenderId: "787064134971",
  appId: "1:787064134971:web:48a8e46440a1042a386b1e",
  measurementId: "G-YJT2MHWCNV",
};

/** Browser-only Firebase app instance. Returns null during SSR. */
export function getFirebaseApp(): FirebaseApp | null {
  if (typeof window === "undefined") return null;
  return getApps()[0] ?? initializeApp(firebaseConfig);
}

/** Lazily resolves Firebase Analytics; null on SSR or unsupported browsers. */
export async function getFirebaseAnalytics(): Promise<Analytics | null> {
  const app = getFirebaseApp();
  if (!app || !(await isSupported().catch(() => false))) return null;
  return getAnalytics(app);
}
