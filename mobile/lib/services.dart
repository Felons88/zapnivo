import 'dart:async';
import 'dart:convert';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:http/http.dart' as http;
import 'package:ota_update/ota_update.dart';
import 'package:package_info_plus/package_info_plus.dart';
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
  bool _checking = false;

  void start() {
    stop();
    check();
    _timer = Timer.periodic(const Duration(minutes: 5), (_) => check());
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
      final build = (j['build'] as num).toInt();
      final current = int.tryParse((await PackageInfo.fromPlatform()).buildNumber) ?? 0;
      final url = j['apk_url'] as String;
      if (build > current && Uri.tryParse(url)?.scheme == 'https') {
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
          default:
            progress = null;
            status = 'Update failed. Try again later.';
        }
        notifyListeners();
      }
    } catch (_) {
      status = 'Update failed. Try again later.';
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
