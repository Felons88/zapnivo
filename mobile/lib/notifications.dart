import 'dart:async';

import 'package:flutter/material.dart';

import 'animations.dart';
import 'api.dart';
import 'app_state.dart';
import 'settings.dart';
import 'support.dart';
import 'theme.dart';
import 'wallet.dart';
import 'widgets.dart';

/// Category → icon/accent. Payment & security read as essential; offers muted.
(IconData, Color) _categoryStyle(String c) => switch (c) {
  'security' => (Icons.shield_outlined, const Color(0xFFFF9F43)),
  'payment' => (Icons.account_balance_wallet_outlined, lime),
  'rental' => (Icons.battery_charging_full_rounded, Colors.white),
  'support' => (Icons.support_agent_outlined, const Color(0xFF7EC8E3)),
  'offer' => (Icons.local_offer_outlined, muted),
  _ => (Icons.person_outline_rounded, muted),
};

const _filters = <(String?, String)>[
  (null, 'All'),
  ('unread', 'Unread'),
  ('security', 'Security'),
  ('payment', 'Payments'),
  ('rental', 'Rentals'),
  ('support', 'Support'),
  ('offer', 'Offers'),
];

/// The persistent notification center — server-backed history synced across
/// devices, realtime badge, category filters, read state and deep links.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});
  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  final _items = <AppNotification>[];
  String? _filter; // null = All, 'unread' = unread only, else a category
  String? _nextBefore;
  String? _error;
  bool _loading = true;
  bool _loadingMore = false;
  bool _markingAll = false;
  VoidCallback? _tickListener;

  @override
  void initState() {
    super.initState();
    _load();
    // Realtime: a new notification while this screen is open slides in at top.
    final app = AppScope.of(context);
    _tickListener = () => _load(silent: true);
    app.notifTick.addListener(_tickListener!);
  }

  @override
  void dispose() {
    if (_tickListener != null) AppScope.of(context).notifTick.removeListener(_tickListener!);
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    final app = AppScope.of(context);
    if (!silent) setState(() { _loading = true; _error = null; });
    try {
      final r = await app.api.notifications(
        category: _filter == 'unread' ? null : _filter,
        unreadOnly: _filter == 'unread',
      );
      if (!mounted) return;
      setState(() {
        _items
          ..clear()
          ..addAll(r.items);
        _nextBefore = r.nextBefore;
        _loading = false;
      });
      app.unreadNotifications = r.unread;
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _loading = false; });
    } catch (_) {
      if (mounted) setState(() { _error = 'Notifications could not be loaded.'; _loading = false; });
    }
  }

  Future<void> _loadMore() async {
    if (_nextBefore == null || _loadingMore) return;
    setState(() => _loadingMore = true);
    try {
      final r = await AppScope.of(context).api.notifications(
        category: _filter == 'unread' ? null : _filter,
        unreadOnly: _filter == 'unread',
        before: _nextBefore,
      );
      if (!mounted) return;
      setState(() { _items.addAll(r.items); _nextBefore = r.nextBefore; _loadingMore = false; });
    } catch (_) {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _mark(AppNotification n, {bool unread = false}) async {
    final app = AppScope.of(context);
    try {
      await app.api.markNotification(n.id, unread: unread);
      await _load(silent: true);
      unawaited(app.refreshNotificationCount());
    } catch (_) {}
  }

  Future<void> _markAll() async {
    if (_markingAll) return;
    final app = AppScope.of(context);
    setState(() => _markingAll = true);
    try {
      await app.api.markAllNotificationsRead();
      await _load(silent: true);
      unawaited(app.refreshNotificationCount());
    } catch (_) {}
    if (mounted) setState(() => _markingAll = false);
  }

  /// Contextual deep link — server-side allowlisted shapes only. Tab targets
  /// switch tabs (popping back to the shell); tickets/wallet open their screen.
  void _open(AppNotification n, AppState app) {
    if (!n.read) _mark(n);
    final link = n.deepLink;
    if (link == null) return;
    if (link.startsWith('ticket:')) {
      final number = link.substring(7);
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => TicketThreadScreen(number: number)));
    } else if (link.startsWith('rental:')) {
      app.setTab(2);
      Navigator.of(context).maybePop();
    } else if (link == 'wallet') {
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const WalletScreen()));
    } else if (link == 'account') {
      app.setTab(4);
      Navigator.of(context).maybePop();
    } else if (link == 'support') {
      app.setTab(3);
      Navigator.of(context).maybePop();
    }
  }

  String _when(DateTime? t) {
    if (t == null) return '';
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 1) return 'now';
    if (d.inMinutes < 60) return '${d.inMinutes}m';
    if (d.inHours < 24) return '${d.inHours}h';
    if (d.inDays < 7) return '${d.inDays}d';
    return formatDate(t);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return TitledPage(
      title: 'Notifications',
      onRefresh: _load,
      children: [
        // Filter chips
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final (value, label) in _filters)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: GestureDetector(
                    onTap: () { setState(() => _filter = value); _load(); },
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 160),
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                      decoration: BoxDecoration(
                        color: _filter == value ? lime : Colors.white.withValues(alpha: 0.08),
                        borderRadius: BorderRadius.circular(20),
                      ),
                      child: Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: _filter == value ? ink : Colors.white)),
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            if (app.unreadNotifications > 0)
              Text('${app.unreadNotifications} unread', style: const TextStyle(color: muted, fontSize: 13)),
            const Spacer(),
            TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const NotificationSettingsScreen())),
              child: const Text('Preferences'),
            ),
            if (app.unreadNotifications > 0)
              TextButton(onPressed: _markingAll ? null : _markAll, child: Text(_markingAll ? 'Marking…' : 'Mark all read')),
          ],
        ),
        const SizedBox(height: 4),
        if (_loading && _items.isEmpty)
          const SkeletonList()
        else if (_error != null && _items.isEmpty)
          StateCard(icon: Icons.wifi_off, title: 'Could not load', body: _error!, action: TextButton(onPressed: _load, child: const Text('Try again')))
        else if (_items.isEmpty)
          const EmptyState(icon: Icons.notifications_none_rounded, title: 'All caught up', body: 'Account, payment, rental and support updates will appear here — even when the app was closed.')
        else
          for (final n in _items) _NotificationTile(n: n, when: _when(n.createdAt), onTap: () => _open(n, app), onToggleRead: () => _mark(n, unread: n.read)),
        if (_nextBefore != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Center(
              child: TextButton(onPressed: _loadingMore ? null : _loadMore, child: Text(_loadingMore ? 'Loading…' : 'Load older')),
            ),
          ),
      ],
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.n, required this.when, required this.onTap, required this.onToggleRead});
  final AppNotification n;
  final String when;
  final VoidCallback onTap;
  final VoidCallback onToggleRead;

  @override
  Widget build(BuildContext context) {
    final (icon, accent) = _categoryStyle(n.category);
    return InkWell(
      onTap: onTap,
      onLongPress: onToggleRead,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(color: accent.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(12)),
              child: Icon(icon, size: 20, color: accent),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(child: Text(n.title, style: TextStyle(fontSize: 15, fontWeight: n.read ? FontWeight.w500 : FontWeight.w800))),
                      Text(when, style: const TextStyle(color: muted, fontSize: 12)),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(n.body, style: TextStyle(color: muted, fontSize: 13.5, height: 1.35, fontWeight: n.read ? FontWeight.w400 : FontWeight.w500)),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Container(
                width: 8, height: 8,
                decoration: BoxDecoration(shape: BoxShape.circle, color: n.read ? Colors.transparent : lime),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
