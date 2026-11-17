import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:ota_update/ota_update.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'api.dart';

@pragma('vm:entry-point')
Future<void> firebaseBackgroundHandler(RemoteMessage message) async {}

/// Firebase Cloud Messaging. Silently stays off until android/app/google-services.json is added.
class PushService {
  static bool available = false;
  static String? _token;
  static final _local = FlutterLocalNotificationsPlugin();
  static void Function(Map<String, dynamic> data)? onOpen;

  static Future<void> init() async {
    try {
      await Firebase.initializeApp();
      FirebaseMessaging.onBackgroundMessage(firebaseBackgroundHandler);
      await _local.initialize(
        settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')),
        onDidReceiveNotificationResponse: (r) {
          if (r.payload != null) onOpen?.call(jsonDecode(r.payload!) as Map<String, dynamic>);
        },
      );
      await _local
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(const AndroidNotificationChannel('zapnivo_default', 'Rental & support updates', importance: Importance.high));
      FirebaseMessaging.onMessage.listen((m) {
        final n = m.notification;
        if (n == null) return;
        _local.show(
          id: n.hashCode,
          title: n.title,
          body: n.body,
          notificationDetails: const NotificationDetails(
            android: AndroidNotificationDetails('zapnivo_default', 'Rental & support updates', importance: Importance.high, priority: Priority.high),
          ),
          payload: jsonEncode(m.data),
        );
      });
      FirebaseMessaging.onMessageOpenedApp.listen((m) => onOpen?.call(m.data));
      final initial = await FirebaseMessaging.instance.getInitialMessage();
      if (initial != null) onOpen?.call(initial.data);
      available = true;
    } catch (e) {
      debugPrint('Push disabled: $e');
    }
  }

  static Future<void> register(ZapnivoApi api) async {
    if (!available) return;
    try {
      final version = (await PackageInfo.fromPlatform()).version;
      _token = await FirebaseMessaging.instance.getToken();
      if (_token != null) await api.registerDevice(_token!, version);
      FirebaseMessaging.instance.onTokenRefresh.listen((t) {
        _token = t;
        api.registerDevice(t, version).catchError((_) {});
      });
    } catch (e) {
      debugPrint('Push registration failed: $e');
    }
  }

  static Future<void> unregister(ZapnivoApi api) async {
    final t = _token;
    if (!available || t == null) return;
    try {
      await api.unregisterDevice(t);
    } catch (_) {}
  }
}

class UpdateInfo {
  const UpdateInfo({required this.version, required this.build, required this.apkUrl, required this.notes, required this.mandatory});
  final String version;
  final int build;
  final String apkUrl;
  final String notes;
  final bool mandatory;
}

/// Polls `app-releases/latest.json` in the public Supabase bucket every 5 minutes and, when a newer
/// build exists, downloads and installs it (Android shows the one-tap install confirmation).
class Updater extends ChangeNotifier {
  Timer? _timer;
  UpdateInfo? available;
  double? progress;
  String? status;
  /// Non-null when the running build is newer than the last-launched build —
  /// i.e. an OTA update just installed. Shown as the "App updated" celebration.
  String? justUpdated;
  bool _checking = false;

  static const _buildKey = 'zapnivo.last_build';

  void start() {
    stop();
    _detectJustUpdated();
    check();
    _timer = Timer.periodic(const Duration(minutes: 5), (_) => check());
  }

  /// The OS installer kills the app during OTA install, so "updated" can only
  /// be detected on the NEXT launch: compare the installed build against the
  /// build stored from the previous run.
  Future<void> _detectJustUpdated() async {
    try {
      final info = await PackageInfo.fromPlatform();
      final current = (int.tryParse(info.buildNumber) ?? 0) % 1000; // strip ABI split offset
      final prefs = await SharedPreferences.getInstance();
      final last = prefs.getInt(_buildKey);
      if (last != null && current > last % 1000) justUpdated = info.version;
      await prefs.setInt(_buildKey, current);
      if (justUpdated != null) notifyListeners();
    } catch (_) {}
  }

  void clearJustUpdated() {
    justUpdated = null;
    notifyListeners();
  }

  /// Semver-ish fallback: '1.3.0' > '1.2.1' — ABI offsets can't corrupt a name.
  static bool _versionNewer(String remote, String local) {
    List<int> parts(String v) => v.split('.').map((s) => int.tryParse(s) ?? 0).toList();
    final a = parts(remote), b = parts(local);
    for (var i = 0; i < 3; i++) {
      final x = i < a.length ? a[i] : 0, y = i < b.length ? b[i] : 0;
      if (x != y) return x > y;
    }
    return false;
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> check() async {
    if (_checking || progress != null || defaultTargetPlatform != TargetPlatform.android) return;
    _checking = true;
    try {
      final base = Supabase.instance.client.rest.url.replaceFirst('/rest/v1', '');
      final res = await http
          .get(Uri.parse('$base/storage/v1/object/public/app-releases/latest.json?t=${DateTime.now().millisecondsSinceEpoch}'))
          .timeout(const Duration(seconds: 12));
      if (res.statusCode != 200) return;
      final j = jsonDecode(res.body) as Map<String, dynamic>;
      // %1000 strips the ABI offset Flutter adds to split-per-abi APKs
      // (armeabi=+1000, arm64=+2000, x86_64=+3000 → raw code 4 becomes 2004).
      final build = (j['build'] as num).toInt() % 1000;
      final info = await PackageInfo.fromPlatform();
      final current = (int.tryParse(info.buildNumber) ?? 0) % 1000;
      final url = j['apk_url'] as String;
      if ((build > current || _versionNewer(j['version'] as String? ?? '', info.version)) && Uri.tryParse(url)?.scheme == 'https') {
        available = UpdateInfo(version: j['version'] as String? ?? '', build: build, apkUrl: url, notes: j['notes'] as String? ?? '', mandatory: j['mandatory'] == true);
      } else {
        available = null;
      }
      notifyListeners();
    } catch (_) {
    } finally {
      _checking = false;
    }
  }

  void dismiss() {
    if (available?.mandatory == true) return;
    available = null;
    notifyListeners();
  }

  Future<void> install() async {
    final info = available;
    if (info == null || progress != null) return;

    // Android 8+: REQUEST_INSTALL_PACKAGES in the manifest only lets us ASK —
    // the per-app "Install unknown apps" toggle must be ON or the installer
    // intent dies silently and the app just closes. Request it first; the
    // request() call opens the correct settings screen for this app.
    final perm = await Permission.requestInstallPackages.status;
    if (!perm.isGranted) {
      status = 'Allow "Install unknown apps" for Zapnivo on the next screen, then come back and tap Update now.';
      notifyListeners();
      await Permission.requestInstallPackages.request();
      // User returns from settings; they tap Update again — don't auto-retry,
      // we can't tell whether they actually granted it until the next launch.
      return;
    }

    progress = 0;
    status = 'Downloading update…';
    notifyListeners();
    try {
      await for (final e in OtaUpdate().execute(info.apkUrl, destinationFilename: 'zapnivo-${info.build}.apk')) {
        switch (e.status) {
          case OtaStatus.DOWNLOADING:
            progress = (double.tryParse(e.value ?? '0') ?? 0) / 100;
            status = 'Downloading update… ${e.value ?? 0}%';
          case OtaStatus.INSTALLING:
            progress = 1;
            status = 'Opening installer…';
          case OtaStatus.INSTALLATION_DONE:
            progress = null;
            status = null;
          case OtaStatus.PERMISSION_NOT_GRANTED_ERROR:
            progress = null;
            status = 'Install permission was denied — allow "Install unknown apps" for Zapnivo in Settings.';
          case OtaStatus.DOWNLOAD_ERROR:
            progress = null;
            status = 'Download failed. Check your connection and try again.';
          case OtaStatus.CHECKSUM_ERROR:
            progress = null;
            status = 'The update file failed verification.';
          case OtaStatus.ALREADY_RUNNING_ERROR:
            progress = null;
            status = 'An update is already in progress.';
          default:
            progress = null;
            // INTERNAL_ERROR etc. — e.value often carries the OS reason.
            final detail = (e.value ?? '').trim();
            status = detail.isNotEmpty && detail.length < 120
                ? 'Update failed: $detail'
                : 'Update failed. If it was already installed, open the app again.';
        }
        notifyListeners();
      }
    } catch (e) {
      // The plugin reports failures as stream errors carrying the OS reason
      // ("Installation failed: …", download errors, permission denials).
      progress = null;
      final msg = e.toString();
      if (msg.toLowerCase().contains('permission')) {
        status = 'Install permission was denied — allow "Install unknown apps" for Zapnivo in Settings.';
      } else if (msg.toLowerCase().contains('download') || msg.toLowerCase().contains('http')) {
        status = 'Download failed. Check your connection and try again.';
      } else {
        status = msg.length < 140 ? 'Update failed: $msg' : 'Update failed. Try again later.';
      }
    }
    progress = null;
    notifyListeners();
  }

  @override
  void dispose() {
    stop();
    super.dispose();
  }
}
