import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart';

import 'theme.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Logo(size: 76, word: false),
          SizedBox(height: 18),
          Text('Zapnivo', style: TextStyle(fontSize: 40, fontWeight: FontWeight.w900, letterSpacing: -1.5)),
          SizedBox(height: 4),
          Text('Portable Charger Rentals', style: TextStyle(color: muted)),
          SizedBox(height: 36),
          SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5, color: lime)),
        ],
      ),
    ),
  );
}

class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, required this.onComplete});
  final VoidCallback onComplete;
  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final controller = PageController();
  int page = 0;

  static const steps = [
    (Icons.battery_charging_full_rounded, 'Portable Charging, Anywhere', 'Rent a portable charger and keep your devices powered throughout your day.'),
    (Icons.location_on_rounded, 'Find Nearby Charger Stations', 'Quickly locate Zapnivo stations around you on the map or in a list.'),
    (Icons.swap_horiz_rounded, 'Rent, Recharge, Return', 'A simple, seamless way to stay powered with Zapnivo. Return to any live station.'),
  ];

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  void next() {
    if (page < steps.length - 1) {
      controller.nextPage(duration: const Duration(milliseconds: 320), curve: Curves.easeOutCubic);
    } else {
      widget.onComplete();
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            Expanded(
              child: PageView.builder(
                controller: controller,
                itemCount: steps.length,
                onPageChanged: (i) => setState(() => page = i),
                itemBuilder: (_, i) => Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Glass(
                      radius: 40,
                      padding: const EdgeInsets.all(44),
                      child: Icon(steps[i].$1, color: lime, size: 120),
                    ),
                    const SizedBox(height: 40),
                    Text(steps[i].$2, textAlign: TextAlign.center, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w900, letterSpacing: -1)),
                    const SizedBox(height: 12),
                    Text(steps[i].$3, textAlign: TextAlign.center, style: const TextStyle(color: muted, fontSize: 16, height: 1.5)),
                  ],
                ),
              ),
            ),
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: List.generate(
                steps.length,
                (i) => AnimatedContainer(
                  duration: const Duration(milliseconds: 220),
                  width: i == page ? 26 : 8,
                  height: 8,
                  margin: const EdgeInsets.symmetric(horizontal: 3),
                  decoration: BoxDecoration(color: i == page ? lime : Colors.white24, borderRadius: BorderRadius.circular(9)),
                ),
              ),
            ),
            const SizedBox(height: 22),
            PrimaryButton(label: page == steps.length - 1 ? 'Get Started' : 'Next', onPressed: next),
            SizedBox(
              height: 48,
              child: page == steps.length - 1
                  ? null
                  : TextButton(onPressed: widget.onComplete, child: const Text('Skip', style: TextStyle(color: muted))),
            ),
          ],
        ),
      ),
    ),
  );
}

/// Asks for location, then notifications. Every step can be skipped; the app
/// works without either permission.
class PermissionsFlow extends StatefulWidget {
  const PermissionsFlow({super.key, required this.onComplete});
  final VoidCallback onComplete;
  @override
  State<PermissionsFlow> createState() => _PermissionsFlowState();
}

class _PermissionsFlowState extends State<PermissionsFlow> {
  int step = 0;
  bool busy = false;

  Future<void> allow() async {
    setState(() => busy = true);
    try {
      if (step == 0) {
        if (await Geolocator.isLocationServiceEnabled()) await Geolocator.requestPermission();
      } else {
        await Permission.notification.request();
      }
    } catch (_) {}
    if (mounted) {
      setState(() => busy = false);
      advance();
    }
  }

  void advance() {
    if (step == 0) {
      setState(() => step = 1);
    } else {
      widget.onComplete();
    }
  }

  @override
  Widget build(BuildContext context) {
    final location = step == 0;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Glass(
                      radius: 60,
                      padding: const EdgeInsets.all(40),
                      child: Icon(location ? Icons.map_rounded : Icons.notifications_active_rounded, color: lime, size: 96),
                    ),
                    const SizedBox(height: 36),
                    Text(location ? 'Allow Location' : 'Allow Notifications', style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w900, letterSpacing: -1)),
                    const SizedBox(height: 12),
                    Text(
                      location
                          ? 'Find nearby charger stations, get directions, and see availability in real time.'
                          : 'Get rental updates, return reminders, and receipts.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: muted, fontSize: 16, height: 1.5),
                    ),
                  ],
                ),
              ),
              PrimaryButton(label: location ? 'Allow Location' : 'Allow Notifications', onPressed: allow, loading: busy),
              TextButton(onPressed: busy ? null : advance, child: const Text('Not Now', style: TextStyle(color: muted))),
            ],
          ),
        ),
      ),
    );
  }
}
