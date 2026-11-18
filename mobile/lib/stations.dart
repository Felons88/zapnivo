import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'app_state.dart';
import 'rental_flow.dart';
import 'theme.dart';

/// Public Mapbox token for raster tiles — supplied at build time:
/// flutter build apk --dart-define=MAPBOX_PUBLIC_TOKEN=pk.… (public, app-restricted).
const mapboxToken = String.fromEnvironment('MAPBOX_PUBLIC_TOKEN');

/// A rental can start only when the backend reports the station usable AND a
/// bank is ready. `stationState` (available/offline/maintenance/stale) comes
/// from live telemetry; on older payloads we fall back to rentalsAvailable.
bool stationAvailable(Station s) {
  // Test stations are rentable by definition — the server relaxes its live
  // gates for test-mode kiosks, so simulated rentals can start.
  if (s.testMode) return true;
  if (s.stationState != null) return s.stationState == 'available' && (s.readyBanks ?? 1) > 0;
  return s.rentalsAvailable != false && (s.readyBanks ?? 1) > 0;
}

Color stationDot(Station s) {
  switch (s.stationState) {
    case 'offline':
      return danger;
    case 'maintenance':
      return const Color(0xFFF59E0B);
    case 'stale':
      return muted;
    default:
      return stationAvailable(s) ? lime : danger;
  }
}

String availabilityLabel(Station s) {
  if (s.testMode) return 'Test mode';
  switch (s.stationState) {
    case 'offline':
      return 'Station offline';
    case 'maintenance':
      return 'Under maintenance';
    case 'stale':
      return 'Status unconfirmed';
  }
  if ((s.readyBanks ?? 0) > 0) return '${s.readyBanks} charger${s.readyBanks == 1 ? '' : 's'} available';
  return s.rentalsAvailable == false ? 'No chargers ready' : 'Chargers available';
}

void openDirections(Station s) {
  if (s.lat == null || s.lng == null) return;
  launchUrl(
    Uri.parse('https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}'),
    mode: LaunchMode.externalApplication,
  );
}

void openStationDetail(BuildContext context, Station station) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => StationDetailScreen(station: station)));

class StationTile extends StatelessWidget {
  const StationTile({super.key, required this.station, required this.onTap, this.miles});
  final Station station;
  final VoidCallback onTap;
  final double? miles;
  @override
  Widget build(BuildContext context) {
    return Glass(
      radius: 20,
      onTap: onTap,
      child: Row(
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(color: lime, borderRadius: BorderRadius.circular(14)),
            child: const Icon(Icons.bolt_rounded, color: ink),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(station.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                const SizedBox(height: 2),
                Text(
                  [if (miles != null) distanceLabel(miles), station.address].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: muted, fontSize: 13),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Dot(color: stationDot(station)),
                    const SizedBox(width: 6),
                    Text(availabilityLabel(station), style: TextStyle(color: stationDot(station), fontSize: 12, fontWeight: FontWeight.w700)),
                  ],
                ),
              ],
            ),
          ),
          const Icon(Icons.chevron_right, color: muted),
        ],
      ),
    );
  }
}

class MapTab extends StatefulWidget {
  const MapTab({super.key});
  @override
  State<MapTab> createState() => _MapTabState();
}

class _MapTabState extends State<MapTab> {
  bool listMode = true;
  Station? selected;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 14, 20, 12),
          child: Row(
            children: [
              const Expanded(child: ScreenHeader(title: 'Find Chargers', eyebrow: 'Nearby first')),
              Glass(
                radius: 16,
                padding: const EdgeInsets.all(4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    _toggle(Icons.view_list_rounded, listMode, () => setState(() => listMode = true)),
                    _toggle(Icons.map_outlined, !listMode, () => setState(() => listMode = false)),
                  ],
                ),
              ),
            ],
          ),
        ),
        Expanded(child: listMode ? const StationListView() : _map(app)),
      ],
    );
  }

  Widget _toggle(IconData icon, bool on, VoidCallback tap) => GestureDetector(
    onTap: tap,
    child: Container(
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(color: on ? lime : Colors.transparent, borderRadius: BorderRadius.circular(12)),
      child: Icon(icon, size: 20, color: on ? ink : Colors.white),
    ),
  );

  Widget _map(AppState app) {
    final mappable = app.stations.where((s) => s.lat != null && s.lng != null).toList();
    if (app.stationsLoading && app.snapshot == null) return const Center(child: CircularProgressIndicator(color: lime));
    if (app.stationsError != null && app.snapshot == null) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: StateCard(
          icon: Icons.wifi_off,
          title: 'Could not load stations',
          body: app.stationsError!,
          action: TextButton(onPressed: app.refreshStations, child: const Text('Try again')),
        ),
      );
    }
    final pos = app.position;
    final center = pos != null
        ? LatLng(pos.latitude, pos.longitude)
        : mappable.isNotEmpty
        ? LatLng(mappable.first.lat!, mappable.first.lng!)
        : const LatLng(44.9778, -93.2650);
    return Stack(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(28),
            child: FlutterMap(
              options: MapOptions(
                initialCenter: center,
                initialZoom: mappable.isEmpty && pos == null ? 9 : 13,
                onTap: (_, _) => setState(() => selected = null),
              ),
              children: [
                TileLayer(
                  // Mapbox raster tiles when the build provides a public token
                  // (flutter build --dart-define=MAPBOX_PUBLIC_TOKEN=pk.…);
                  // otherwise honest OSM fallback — pins/data are identical.
                  urlTemplate: mapboxToken.isNotEmpty
                      ? 'https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/512/{z}/{x}/{y}@2x?access_token=$mapboxToken'
                      : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'com.zapnivo.charging',
                ),
                MarkerLayer(
                  markers: [
                    if (pos != null)
                      Marker(
                        point: LatLng(pos.latitude, pos.longitude),
                        width: 22,
                        height: 22,
                        child: Container(
                          decoration: BoxDecoration(
                            color: const Color(0xFF3B82F6),
                            shape: BoxShape.circle,
                            border: Border.all(color: Colors.white, width: 3),
                          ),
                        ),
                      ),
                    for (final s in mappable)
                      Marker(
                        point: LatLng(s.lat!, s.lng!),
                        width: 46,
                        height: 46,
                        child: GestureDetector(
                          onTap: () => setState(() => selected = s),
                          child: Container(
                            decoration: BoxDecoration(
                              color: stationAvailable(s) ? lime : Colors.white70,
                              shape: BoxShape.circle,
                              border: Border.all(color: ink, width: 2.5),
                            ),
                            child: const Icon(Icons.bolt_rounded, color: ink),
                          ),
                        ),
                      ),
                  ],
                ),
                SimpleAttributionWidget(
                  source: Text(mapboxToken.isNotEmpty ? '© Mapbox © OpenStreetMap' : 'OpenStreetMap contributors'),
                ),
              ],
            ),
          ),
        ),
        if (mappable.isEmpty)
          const Positioned(
            left: 36,
            right: 36,
            top: 16,
            child: Glass(
              radius: 18,
              child: Text('No verified stations on the map yet. We add a location only after its station is installed.', style: TextStyle(color: muted, fontSize: 13)),
            ),
          ),
        Positioned(
          right: 32,
          top: 16,
          child: mappable.isEmpty
              ? const SizedBox.shrink()
              : Glass(radius: 16, padding: const EdgeInsets.all(10), onTap: app.locate, child: const Icon(Icons.my_location, size: 20)),
        ),
        if (selected != null)
          Positioned(
            left: 32,
            right: 32,
            bottom: 112,
            child: StationTile(
              station: selected!,
              miles: app.distanceMiles(selected!),
              onTap: () => openStationDetail(context, selected!),
            ),
          ),
        if (selected == null)
          Positioned(
            left: 32,
            right: 32,
            bottom: 112,
            child: Glass(
              radius: 20,
              onTap: () => setState(() => listMode = true),
              child: Row(
                children: [
                  const Icon(Icons.bolt_rounded, color: lime),
                  const SizedBox(width: 10),
                  Expanded(child: Text('Nearby Stations (${app.stations.length})', style: const TextStyle(fontWeight: FontWeight.w800))),
                  const Icon(Icons.keyboard_arrow_up, color: muted),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class StationListView extends StatefulWidget {
  const StationListView({super.key});
  @override
  State<StationListView> createState() => _StationListViewState();
}

class _StationListViewState extends State<StationListView> {
  final search = TextEditingController();
  int filter = 0;
  static const filters = ['Nearby', 'Available', 'Favorites', 'Distance'];

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final q = search.text.trim().toLowerCase();
    var list = app.stations.where((s) => q.isEmpty || '${s.name} ${s.address} ${s.city}'.toLowerCase().contains(q));
    if (filter == 0) {
      list = list.where((s) {
        final d = app.distanceMiles(s);
        return d == null || d <= 25;
      });
    }
    if (filter == 1) list = list.where(stationAvailable);
    if (filter == 2) list = list.where(app.isFavorite);
    final sorted = app.sortedByDistance(list);
    final recents = app.recentStations;
    return RefreshIndicator(
      onRefresh: app.refreshStations,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 130),
        children: [
          TextField(
            controller: search,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(hintText: 'Search location or place', prefixIcon: Icon(Icons.search)),
          ),
          const SizedBox(height: 12),
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
          const SizedBox(height: 14),
          if (recents.isNotEmpty && q.isEmpty && filter == 0) ...[
            const Text('Recently viewed', style: TextStyle(color: muted, fontSize: 12, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            SizedBox(
              height: 40,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: recents.length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (_, i) => Glass(
                  radius: 20,
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  onTap: () => openStationDetail(context, recents[i]),
                  child: Row(
                    children: [
                      const Icon(Icons.history, size: 15, color: muted),
                      const SizedBox(width: 6),
                      Text(recents[i].name, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 14),
          ],
          if (app.stationsLoading && app.snapshot == null)
            const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator(color: lime)))
          else if (app.stationsError != null && app.snapshot == null)
            StateCard(
              icon: Icons.wifi_off,
              title: 'Could not load stations',
              body: app.stationsError!,
              action: TextButton(onPressed: app.refreshStations, child: const Text('Try again')),
            )
          else if (sorted.isEmpty)
            const StateCard(
              icon: Icons.location_off_outlined,
              title: 'No stations found',
              body: 'We add a location only after its charger station is installed and verified. Check back for new stations.',
            )
          else
            for (final s in sorted)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: StationTile(station: s, miles: app.distanceMiles(s), onTap: () => openStationDetail(context, s)),
              ),
        ],
      ),
    );
  }
}

class StationDetailScreen extends StatefulWidget {
  const StationDetailScreen({super.key, required this.station});
  final Station station;
  @override
  State<StationDetailScreen> createState() => _StationDetailScreenState();
}

class _StationDetailScreenState extends State<StationDetailScreen> {
  late Station station = widget.station;
  RentalPricing? pricing;
  bool loading = true;
  String? error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => load());
  }

  Future<void> load() async {
    final app = AppScope.of(context);
    pricing = app.pricing;
    unawaited(app.recordViewed(station));
    try {
      final d = await app.api.getStation(station.id);
      station = d.station;
      pricing = d.pricing;
    } on ApiException catch (e) {
      error = e.message;
    }
    if (mounted) setState(() => loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final miles = app.distanceMiles(station);
    final ok = stationAvailable(station);
    final dot = stationDot(station);
    final price = pricing;
    final fav = app.isFavorite(station);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Station Detail'),
        actions: [
          IconButton(
            tooltip: fav ? 'Remove from favorites' : 'Save to favorites',
            icon: Icon(fav ? Icons.star_rounded : Icons.star_outline_rounded, color: fav ? lime : Colors.white),
            onPressed: () => app.toggleFavorite(station),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 36),
        children: [
          Glass(
            padding: const EdgeInsets.all(22),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Eyebrow('Verified station'),
                const SizedBox(height: 8),
                Text(station.name, style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900, letterSpacing: -0.8)),
                if (station.venueType != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(station.venueType!.replaceAll('_', ' '), style: const TextStyle(color: lime, fontSize: 12, fontWeight: FontWeight.w700)),
                  ),
                const SizedBox(height: 8),
                Text(station.address, style: const TextStyle(color: muted, fontSize: 15)),
                if (miles != null) Text('${distanceLabel(miles)} away', style: const TextStyle(color: muted)),
                if (station.hours != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Hours: ${station.hours}', style: const TextStyle(color: muted))),
                if (station.description != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(station.description!, style: const TextStyle(color: muted, fontSize: 13, height: 1.4))),
                if (station.accessibility != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text('Accessibility: ${station.accessibility}', style: const TextStyle(color: muted, fontSize: 12))),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Dot(color: dot),
                    const SizedBox(width: 8),
                    Text(availabilityLabel(station), style: TextStyle(color: dot, fontWeight: FontWeight.w800)),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Glass(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Pricing', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
                const SizedBox(height: 10),
                if (loading && price == null)
                  const LinearProgressIndicator(color: lime)
                else if (price != null) ...[
                  _row('First hour', money(price.firstHourCents)),
                  _row('Each additional hour', money(price.additionalHourCents)),
                  _row('Return within', '${price.nonReturnAfterHours} hours'),
                  _row('Non-return fee', money(price.nonReturnMaxCents)),
                  const SizedBox(height: 8),
                  const Text('Taxes and any temporary card hold are shown at payment.', style: TextStyle(color: muted, fontSize: 12, height: 1.4)),
                ] else
                  const Text('Rentals are not open yet. Approved pricing will appear here before payment is available.', style: TextStyle(color: muted, height: 1.4)),
              ],
            ),
          ),
          if (error != null) ErrorText(error!),
          const SizedBox(height: 18),
          if (station.lat != null && station.lng != null) ...[
            GlassButton(label: 'Directions', icon: Icons.directions_outlined, onPressed: () => openDirections(station)),
            const SizedBox(height: 12),
          ],
          if (station.phone != null) ...[
            GlassButton(label: 'Call venue', icon: Icons.phone_outlined, onPressed: () => launchUrl(Uri.parse('tel:${station.phone}'))),
            const SizedBox(height: 12),
          ],
          if (station.website != null) ...[
            GlassButton(label: 'Venue website', icon: Icons.open_in_new, onPressed: () => launchUrl(Uri.parse(station.website!), mode: LaunchMode.externalApplication)),
            const SizedBox(height: 12),
          ],
          if (price == null)
            const SizedBox.shrink()
          else if (!ok)
            const StateCard(
              icon: Icons.do_not_disturb_on_outlined,
              title: 'No chargers ready right now',
              body: 'This station cannot start a rental at the moment. Try another station or check back soon.',
            )
          else
            PrimaryButton(
              label: 'Start Rental',
              icon: Icons.qr_code_scanner,
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => ScanScreen.rental(station: station, pricing: price)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _row(String a, String b) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [Text(a, style: const TextStyle(color: muted)), Text(b, style: const TextStyle(fontWeight: FontWeight.w800))],
    ),
  );
}
