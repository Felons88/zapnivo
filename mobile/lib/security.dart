import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import 'api.dart';
import 'app_state.dart';
import 'theme.dart';

const _mapboxToken = String.fromEnvironment('MAPBOX_PUBLIC_TOKEN');

/// Sign-in activity detail — Google-style "was this you?" card: an approximate
/// location map (IP-derived, never exact), the device, and when it happened.
/// Opened from security notifications; the payload comes from the
/// notification's server-whitelisted data map.
class SignInActivityScreen extends StatelessWidget {
  const SignInActivityScreen({super.key, required this.notification});
  final AppNotification notification;

  double? get _lat => double.tryParse(notification.data['lat'] ?? '');
  double? get _lng => double.tryParse(notification.data['lng'] ?? '');
  String get _place => notification.data['place'] ?? '';
  String get _device => notification.data['device'] ?? 'this device';

  @override
  Widget build(BuildContext context) {
    final hasPoint = _lat != null && _lng != null;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(8, 4, 8, 32),
          children: [
            Row(children: [
              IconButton(onPressed: () => Navigator.of(context).maybePop(), icon: const Icon(Icons.arrow_back_rounded)),
              const Expanded(child: Center(child: Text('Sign-in activity', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w900, letterSpacing: -0.4)))),
              const SizedBox(width: 48),
            ]),
            const SizedBox(height: 12),

            if (hasPoint)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(24),
                  child: SizedBox(
                    height: 260,
                    child: FlutterMap(
                      options: MapOptions(initialCenter: LatLng(_lat!, _lng!), initialZoom: 9, interactionOptions: const InteractionOptions(flags: InteractiveFlag.pinchZoom | InteractiveFlag.drag)),
                      children: [
                        TileLayer(
                          urlTemplate: _mapboxToken.isNotEmpty
                              ? 'https://api.mapbox.com/styles/v1/mapbox/dark-v11/tiles/512/{z}/{x}/{y}@2x?access_token=$_mapboxToken'
                              : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                          userAgentPackageName: 'com.zapnivo.charging',
                        ),
                        // Approximate-location circle (like Google's security
                        // alerts) — IP geolocation is never presented as exact.
                        CircleLayer(circles: [
                          CircleMarker(point: LatLng(_lat!, _lng!), radius: 30000, useRadiusInMeter: true, color: lime.withValues(alpha: 0.12), borderColor: lime.withValues(alpha: 0.5), borderStrokeWidth: 1.5),
                        ]),
                        MarkerLayer(markers: [
                          Marker(
                            point: LatLng(_lat!, _lng!), width: 40, height: 40,
                            child: Container(
                              decoration: BoxDecoration(color: lime, shape: BoxShape.circle, border: Border.all(color: ink, width: 2.5)),
                              child: const Icon(Icons.smartphone_rounded, color: ink, size: 20),
                            ),
                          ),
                        ]),
                      ],
                    ),
                  ),
                ),
              ),
            if (hasPoint) const SizedBox(height: 8),
            if (hasPoint)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 20),
                child: Text('Approximate area based on network location — not a precise address.', textAlign: TextAlign.center, style: TextStyle(color: muted, fontSize: 11.5, height: 1.4)),
              ),
            const SizedBox(height: 16),

            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Glass(
                radius: 20,
                padding: const EdgeInsets.all(20),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(notification.title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 10),
                  _row(Icons.smartphone_rounded, 'Device', _device),
                  if (_place.isNotEmpty) _row(Icons.place_outlined, 'Area', _place),
                  if (notification.createdAt != null) _row(Icons.schedule_outlined, 'When', _fmt(notification.createdAt!)),
                  const SizedBox(height: 14),
                  Text(notification.body, style: const TextStyle(color: muted, fontSize: 13, height: 1.5)),
                ]),
              ),
            ),
            const SizedBox(height: 12),

            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Glass(
                radius: 20,
                padding: const EdgeInsets.all(20),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text("Wasn't you?", style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 6),
                  const Text('If you don\'t recognise this sign-in, contact support right away and change your password.', style: TextStyle(color: muted, fontSize: 13, height: 1.5)),
                  const SizedBox(height: 12),
                  GlassButton(label: 'Contact support', icon: Icons.support_agent_outlined, onPressed: () {
                    AppScope.of(context).setTab(3);
                    Navigator.of(context).pop();
                  }),
                ]),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static Widget _row(IconData icon, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(children: [
      Icon(icon, size: 16, color: muted),
      const SizedBox(width: 8),
      Text('$label  ', style: const TextStyle(color: muted, fontSize: 12.5)),
      Expanded(child: Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
    ]),
  );

  static String _fmt(DateTime t) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    final h = t.hour % 12 == 0 ? 12 : t.hour % 12;
    final ap = t.hour < 12 ? 'AM' : 'PM';
    return '${months[t.month - 1]} ${t.day}, $h:${t.minute.toString().padLeft(2, '0')} $ap';
  }
}
