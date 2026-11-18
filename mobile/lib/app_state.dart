import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'api.dart';
import 'services.dart';
import 'widget_sync.dart';

class AppState extends ChangeNotifier {
  AppState({ZapnivoApi? api}) : api = api ?? ZapnivoApi();
  final ZapnivoApi api;
  final updater = Updater();

  StationSnapshot? snapshot;
  String? stationsError;
  bool stationsLoading = true;

  List<Rental>? rentals;
  String? rentalsError;

  List<TicketSummary>? tickets;
  List<String> ticketCategories = const [];
  String? ticketsError;
  /// Bumped when a support message arrives so open threads reload.
  final ticketTick = ValueNotifier<int>(0);

  Map<String, dynamic>? profile;

  Position? position;
  bool locationDenied = false;
  PermissionStatus? notificationStatus;

  /// Locally saved favorite station ids and recently-viewed order (newest first).
  Set<String> favorites = {};
  List<String> recentIds = [];

  Timer? _poll;
  RealtimeChannel? _channel;
  int tab = 0;
  bool _started = false;

  void setTab(int i) {
    tab = i;
    notifyListeners();
  }

  void start() {
    if (_started) return;
    _started = true;
    refreshStations();
    refreshRentals();
    refreshTickets();
    refreshProfile();
    _loadSavedStations();
    locate();
    refreshNotificationStatus();
    updater.start();
    PushService.register(api);
    PushService.onOpen = (data) {
      if (data['type'] == 'ticket') setTab(3);
      if (data['type'] == 'rental') setTab(2);
    };
    _subscribe();
    _poll ??= Timer.periodic(const Duration(seconds: 30), (_) {
      refreshRentals();
      refreshTickets();
    });
  }

  void _subscribe() {
    try {
      final client = Supabase.instance.client;
      final uid = client.auth.currentUser?.id;
      if (uid == null) return;
      _channel = client
          .channel('customer-$uid')
          .onPostgresChanges(event: PostgresChangeEvent.all, schema: 'public', table: 'rentals', callback: (_) => refreshRentals())
          .onPostgresChanges(event: PostgresChangeEvent.all, schema: 'public', table: 'support_tickets', callback: (_) => refreshTickets())
          .onPostgresChanges(
            event: PostgresChangeEvent.insert,
            schema: 'public',
            table: 'support_messages',
            callback: (_) {
              ticketTick.value++;
              refreshTickets();
            },
          )
          .subscribe();
    } catch (_) {}
  }

  void stop() {
    if (!_started) return;
    _started = false;
    _poll?.cancel();
    _poll = null;
    updater.stop();
    PushService.unregister(api);
    final ch = _channel;
    _channel = null;
    if (ch != null) Supabase.instance.client.removeChannel(ch);
    rentals = null;
    tickets = null;
    profile = null;
    tab = 0;
  }

  @override
  void dispose() {
    _poll?.cancel();
    updater.dispose();
    super.dispose();
  }

  static const _favKey = 'zapnivo.station_favorites';
  static const _recentKey = 'zapnivo.station_recent';

  Future<void> _loadSavedStations() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      favorites = (prefs.getStringList(_favKey) ?? []).toSet();
      recentIds = prefs.getStringList(_recentKey) ?? [];
      notifyListeners();
    } catch (_) {}
  }

  bool isFavorite(Station s) => favorites.contains(s.id);

  Future<void> toggleFavorite(Station s) async {
    favorites.contains(s.id) ? favorites.remove(s.id) : favorites.add(s.id);
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_favKey, favorites.toList());
    } catch (_) {}
  }

  /// Records a station detail view — newest first, capped at 5, deduped.
  Future<void> recordViewed(Station s) async {
    recentIds = [s.id, ...recentIds.where((id) => id != s.id)].take(5).toList();
    notifyListeners();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_recentKey, recentIds);
    } catch (_) {}
  }

  List<Station> get recentStations =>
      [for (final id in recentIds) ...stations.where((s) => s.id == id)];

  List<Station> get stations => snapshot?.stations ?? const [];
  RentalPricing? get pricing => snapshot?.pricing;
  Rental? get activeRental => rentals?.where((r) => r.isActive).firstOrNull;
  String get firstName {
    final n = (profile?['name'] as String?)?.trim();
    if (n != null && n.isNotEmpty) return n.split(' ').first;
    final meta = Supabase.instance.client.auth.currentUser?.userMetadata;
    final m = (meta?['full_name'] ?? meta?['name']) as String?;
    if (m != null && m.trim().isNotEmpty) return m.trim().split(' ').first;
    return '';
  }

  Future<void> refreshProfile() async {
    try {
      profile = await api.account();
      notifyListeners();
    } on ApiException {
      // Account details are optional chrome; screens that need them surface their own errors.
    }
  }

  Future<void> refreshStations() async {
    stationsLoading = true;
    stationsError = null;
    notifyListeners();
    try {
      snapshot = await api.getStations();
    } on ApiException catch (e) {
      stationsError = e.message;
    }
    stationsLoading = false;
    notifyListeners();
  }

  Future<void> refreshRentals() async {
    try {
      rentals = await api.rentalList();
      rentalsError = null;
    } on ApiException catch (e) {
      rentalsError = e.message;
    } catch (_) {
      rentalsError = 'Rentals could not be read. Pull to try again.';
    }
    notifyListeners();
    final active = activeRental;
    syncHomeWidget(rental: active == null ? 'No active rental' : 'Active · ${active.reference}');
  }

  Future<void> refreshTickets() async {
    try {
      final r = await api.tickets();
      tickets = r.tickets;
      if (r.categories.isNotEmpty) ticketCategories = r.categories;
      ticketsError = null;
    } on ApiException catch (e) {
      ticketsError = e.message;
    } catch (_) {
      ticketsError = 'Support requests could not be read.';
    }
    notifyListeners();
  }

  Future<void> locate() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return;
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        locationDenied = true;
        notifyListeners();
        return;
      }
      locationDenied = false;
      position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.medium, timeLimit: Duration(seconds: 10)),
      );
    } catch (_) {}
    notifyListeners();
  }

  Future<void> refreshNotificationStatus() async {
    try {
      notificationStatus = await Permission.notification.status;
      notifyListeners();
    } catch (_) {}
  }

  double? distanceMiles(Station s) {
    final p = position;
    if (p == null || s.lat == null || s.lng == null) return null;
    return Geolocator.distanceBetween(p.latitude, p.longitude, s.lat!, s.lng!) / 1609.344;
  }

  List<Station> sortedByDistance([Iterable<Station>? source]) {
    final list = (source ?? stations).toList();
    list.sort((a, b) {
      final da = distanceMiles(a), db = distanceMiles(b);
      if (da == null && db == null) return a.name.compareTo(b.name);
      if (da == null) return 1;
      if (db == null) return -1;
      return da.compareTo(db);
    });
    return list;
  }
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);
  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
}

String distanceLabel(double? miles) => miles == null ? '' : '${miles.toStringAsFixed(miles < 10 ? 1 : 0)} mi';
