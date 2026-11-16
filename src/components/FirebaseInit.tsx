"use client";

import { useEffect } from "react";

/** Boots the Firebase web app (and Analytics where supported) once per page load.
 *  Dynamically imported so the Firebase bundle stays out of the initial payload. */
export default function FirebaseInit() {
  useEffect(() => {
    void import("@/lib/firebase").then((m) => m.getFirebaseAnalytics());
  }, []);
  return null;
}
