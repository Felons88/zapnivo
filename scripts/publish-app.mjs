#!/usr/bin/env node
/**
 * Publishes the Android app to the public `app-releases` Supabase bucket so installed apps
 * auto-update (they poll latest.json every 5 minutes).
 *
 *   cd mobile && flutter build apk --release --split-per-abi
 *   node scripts/publish-app.mjs "What's new in this build"
 *
 * Reads mobile/pubspec.yaml for `version: x.y.z+build`, so bump the build number before releasing.
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (from .env.local or the environment).
 */
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

const pubspec = readFileSync("mobile/pubspec.yaml", "utf8");
const v = /^version:\s*([\d.]+)\+(\d+)/m.exec(pubspec);
if (!v) throw new Error("Could not read version from mobile/pubspec.yaml");
const [, version, build] = v;
// The published OTA channel uses ARM64 split APKs. Flutter adds 2000 to the
// Android versionCode for ARM64; a universal APK with the bare build number
// would be rejected as a downgrade by phones already on this channel.
const apkPath = "mobile/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk";
if (!existsSync(apkPath)) throw new Error(`Build the APK first (${apkPath} missing).`);

const db = createClient(url, key, { auth: { persistSession: false } });
const bucket = db.storage.from("app-releases");
const apkName = `zapnivo-${version}-${build}-arm64-v8a.apk`;

const up = await bucket.upload(apkName, readFileSync(apkPath), { contentType: "application/vnd.android.package-archive", upsert: true });
if (up.error) throw up.error;
const manifest = {
  version, build: Number(build) + 2000, notes: process.argv[2] ?? "", mandatory: process.argv.includes("--mandatory"),
  apk_url: bucket.getPublicUrl(apkName).data.publicUrl, published_at: new Date().toISOString(),
};
const meta = await bucket.upload("latest.json", Buffer.from(JSON.stringify(manifest, null, 2)), { contentType: "application/json", upsert: true, cacheControl: "60" });
if (meta.error) throw meta.error;
console.log(`Published ${version}+${build}\n${manifest.apk_url}\n${bucket.getPublicUrl("latest.json").data.publicUrl}`);
