import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import 'animations.dart';
import 'app_state.dart';
import 'notifications.dart';
import 'rental_flow.dart';
import 'stations.dart';
import 'success.dart';
import 'theme.dart';
import 'widgets.dart';

void _push(BuildContext c, Widget w) => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => w));

class HomeTab extends StatelessWidget {
  const HomeTab({super.key});
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final active = app.activeRental;
    final nearby = app.sortedByDistance().take(3).toList();
    final name = app.firstName;
    return RefreshIndicator(
      onRefresh: () async => await Future.wait([app.refreshStations(), app.refreshRentals(), app.locate()]),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 130),
        children: stagger([
          Row(
            children: [
              const Logo(size: 30),
              const Spacer(),
              Badge(
                isLabelVisible: app.unreadNotifications > 0 || app.updater.available != null,
                label: app.unreadNotifications > 0 ? Text('${app.unreadNotifications > 99 ? "99+" : app.unreadNotifications}', style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Colors.black)) : null,
                smallSize: 10,
                backgroundColor: lime,
                child: Glass(radius: 16, padding: const EdgeInsets.all(10), onTap: () => _push(context, const NotificationsScreen()), child: const Icon(Icons.notifications_none_rounded, size: 22)),
              ),
            ],
          ),
          const SizedBox(height: 26),
          Text(name.isEmpty ? 'Hi there!' : 'Hi, $name!', style: const TextStyle(fontSize: 32, fontWeight: FontWeight.w900, letterSpacing: -1)),
          const Text('Need a charger?', style: TextStyle(color: muted, fontSize: 18)),
          const SizedBox(height: 20),
          Glass(
            radius: 30,
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(Icons.battery_charging_full_rounded, color: lime, size: 54),
                    SizedBox(width: 14),
                    Expanded(child: Text('Rent a Portable Charger', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900, height: 1.1))),
                  ],
                ),
                const SizedBox(height: 10),
                const Text('Find a nearby station, rent a charger, and stay powered.', style: TextStyle(color: muted, height: 1.4)),
                const SizedBox(height: 18),
                PrimaryButton(label: 'Find Stations', icon: Icons.arrow_forward, onPressed: () => app.setTab(1)),
                const SizedBox(height: 10),
                GlassButton(label: 'Scan Station QR', icon: Icons.qr_code_scanner, onPressed: () => _push(context, const ScanScreen.rental())),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (active != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Glass(
                tint: lime,
                radius: 22,
                onTap: () => app.setTab(2),
                child: Row(
                  children: [
                    Pulse(child: const Icon(Icons.timer_outlined, color: lime, size: 28)),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Active Rental', style: TextStyle(fontWeight: FontWeight.w800)),
                          Text('${active.venue} · ${active.stateLabel}', style: const TextStyle(color: muted, fontSize: 13)),
                        ],
                      ),
                    ),
                    const Icon(Icons.chevron_right),
                  ],
                ),
              ),
            ),
          Row(
            children: [
              Expanded(child: _quick(Icons.timer_outlined, 'Active Rental', () => app.setTab(2))),
              const SizedBox(width: 12),
              Expanded(child: _quick(Icons.history_rounded, 'Rental History', () => _push(context, const HistoryScreen()))),
            ],
          ),
          const SizedBox(height: 26),
          Row(
            children: [
              Expanded(child: Text('Nearby Stations (${app.stations.length})', style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800))),
              TextButton(onPressed: () => app.setTab(1), child: const Text('See all')),
            ],
          ),
          const SizedBox(height: 8),
          if (app.stationsLoading && app.snapshot == null)
            const SkeletonList()
          else if (app.stationsError != null && app.snapshot == null)
            StateCard(icon: Icons.wifi_off, title: 'Could not load stations', body: app.stationsError!, action: TextButton(onPressed: app.refreshStations, child: const Text('Try again')))
          else if (nearby.isEmpty)
            const StateCard(icon: Icons.location_off_outlined, title: 'Stations are on the way', body: 'We add a location only after its charger station is installed and verified. Check back for the first live stations.')
          else
            for (final s in nearby) Padding(padding: const EdgeInsets.only(bottom: 12), child: StationTile(station: s, miles: app.distanceMiles(s), onTap: () => openStationDetail(context, s))),
          if (app.locationDenied)
            Glass(
              radius: 18,
              onTap: openAppSettings,
              child: const Row(children: [Icon(Icons.location_off, color: muted), SizedBox(width: 12), Expanded(child: Text('Location is off. Tap to enable it in Settings and see stations near you.', style: TextStyle(color: muted, fontSize: 13)))]),
            ),
        ]),
      ),
    );
  }

  Widget _quick(IconData icon, String label, VoidCallback tap) => Glass(
    radius: 22,
    onTap: tap,
    child: Column(children: [Icon(icon, color: lime), const SizedBox(height: 8), Text(label, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13))]),
  );
}

class RentalsTab extends StatelessWidget {
  const RentalsTab({super.key});
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final active = app.activeRental;
    return RefreshIndicator(
      onRefresh: app.refreshRentals,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 130),
        children: [
          const ScreenHeader(title: 'Rentals', eyebrow: 'Active rental'),
          const SizedBox(height: 16),
          if (app.rentals == null && app.rentalsError != null)
            StateCard(
              icon: Icons.wifi_off,
              title: "Couldn't load your rentals",
              body: app.rentalsError!,
              action: TextButton(onPressed: app.refreshRentals, child: const Text('Try again')),
            )
          else if (app.rentals == null)
            const SkeletonList(count: 2, height: 220)
          else if (active != null)
            FadeSlideIn(child: ActiveRentalPanel(rental: active))
          else
            FadeSlideIn(
              child: StateCard(
                icon: Icons.battery_charging_full,
                title: 'No active rental',
                body: 'Find a station, scan its QR, then review the price before checkout.',
                action: TextButton(onPressed: () => app.setTab(1), child: const Text('Find stations')),
              ),
            ),
          const SizedBox(height: 28),
          const Text('Rental History', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
          const SizedBox(height: 12),
          const HistoryList(),
        ],
      ),
    );
  }
}

class HistoryScreen extends StatelessWidget {
  const HistoryScreen({super.key});
  @override
  Widget build(BuildContext context) => TitledPage(title: 'Rental history', onRefresh: AppScope.of(context).refreshRentals, children: const [HistoryList()]);
}

class HistoryList extends StatefulWidget {
  const HistoryList({super.key});
  @override
  State<HistoryList> createState() => _HistoryListState();
}

class _HistoryListState extends State<HistoryList> {
  int filter = 0;
  static const filters = ['All', 'Completed', 'Ongoing'];

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final all = app.rentals;
    if (all == null) return app.rentalsError != null ? const SizedBox.shrink() : const SkeletonList(count: 2);
    final list = all.where((r) => filter == 0 || (filter == 1 ? !r.isActive : r.isActive)).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            for (var i = 0; i < filters.length; i++)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  label: Text(filters[i]),
                  selected: filter == i,
                  onSelected: (_) => setState(() => filter = i),
                  selectedColor: lime,
                  labelStyle: TextStyle(color: filter == i ? ink : Colors.white, fontWeight: FontWeight.w700),
                  backgroundColor: Colors.white10,
                  side: BorderSide.none,
                  showCheckmark: false,
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),
        if (list.isEmpty)
          const StateCard(icon: Icons.receipt_long_outlined, title: 'No rentals yet', body: 'Your rentals and receipts will appear here.')
        else
          ...stagger([
            for (final r in list)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Glass(
                  radius: 20,
                  onTap: () => _push(context, ReceiptScreen(rental: r)),
                  child: Row(
                    children: [
                      r.isActive ? Pulse(child: const Dot(color: lime)) : const Dot(color: muted),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(r.venue, style: const TextStyle(fontWeight: FontWeight.w800)),
                            Text('${r.reference} · ${r.startedAt != null ? formatDate(r.startedAt!) : r.stateLabel}', style: const TextStyle(color: muted, fontSize: 12)),
                          ],
                        ),
                      ),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(r.stateLabel, style: TextStyle(color: r.isActive ? lime : muted, fontSize: 12, fontWeight: FontWeight.w800)),
                          if (r.amountCents != null) Text(money(r.amountCents!), style: const TextStyle(fontWeight: FontWeight.w800)),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
          ]),
      ],
    );
  }
}
