import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'app_state.dart';
import 'qr_parser.dart';
import 'stations.dart';
import 'success.dart';
import 'widgets.dart';
import 'theme.dart';



enum ScanMode { rental, returnDock }

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.mode, this.station, this.pricing});
  const ScanScreen.rental({super.key, this.station, this.pricing}) : mode = ScanMode.rental;
  const ScanScreen.returnDock({super.key}) : mode = ScanMode.returnDock, station = null, pricing = null;
  final ScanMode mode;
  final Station? station;
  final RentalPricing? pricing;
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  bool handled = false;
  String? error;

  Future<void> manual() async {
    final c = TextEditingController();
    final entered = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Enter station ID'),
        content: TextField(
          controller: c,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          decoration: const InputDecoration(hintText: 'Code below the QR label'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(context, c.text),
            style: FilledButton.styleFrom(backgroundColor: lime, foregroundColor: ink),
            child: const Text('Continue'),
          ),
        ],
      ),
    );
    c.dispose();
    if (entered != null && entered.trim().isNotEmpty) await handle(entered);
  }

  Future<void> handle(String raw) async {
    final id = stationIdFromCode(raw);
    if (id == null) {
      setState(() => error = 'This is not a Zapnivo station code.');
      return;
    }
    final app = AppScope.of(context);
    final navigator = Navigator.of(context);
    setState(() => error = null);
    if (widget.mode == ScanMode.returnDock) {
      navigator.pushReplacement(MaterialPageRoute<void>(builder: (_) => ReturnProgressScreen(dockId: id)));
      return;
    }
    if (widget.station != null && widget.station!.id.toUpperCase() != id) {
      setState(() => error = 'That code belongs to a different station. Scan ${widget.station!.name}.');
      return;
    }
    try {
      final d = await app.api.getStation(id);
      if (d.pricing == null) throw const ApiException('Rentals are not open yet. Nothing has been charged.');
      if (!stationAvailable(d.station)) throw const ApiException('No chargers are ready at this station right now.');
      if (!mounted) return;
      navigator.pushReplacement(MaterialPageRoute<void>(builder: (_) => ConfirmRentalScreen(station: d.station, pricing: d.pricing!)));
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final returning = widget.mode == ScanMode.returnDock;
    return Scaffold(
      appBar: AppBar(title: Text(returning ? 'Return Charger' : 'Start Rental')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
          child: Column(
            children: [
              Text(
                returning ? 'Scan the return dock QR code or station code to complete your return.' : 'Scan the QR code on the station to start your rental.',
                textAlign: TextAlign.center,
                style: const TextStyle(color: muted, height: 1.4),
              ),
              const SizedBox(height: 16),
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(30),
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      Container(color: inkSoft),
                      MobileScanner(
                        onDetect: (capture) {
                          if (handled || capture.barcodes.isEmpty) return;
                          final code = capture.barcodes.first.rawValue;
                          if (code == null) return;
                          handled = true;
                          handle(code).whenComplete(() {
                            if (mounted) setState(() => handled = false);
                          });
                        },
                        errorBuilder: (context, e) => const Center(
                          child: Padding(
                            padding: EdgeInsets.all(28),
                            child: Text('Camera unavailable. Enter the station ID below.', textAlign: TextAlign.center, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                          ),
                        ),
                      ),
                      IgnorePointer(
                        child: Center(
                          child: Container(
                            width: 230,
                            height: 230,
                            decoration: BoxDecoration(border: Border.all(color: lime, width: 3), borderRadius: BorderRadius.circular(28)),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              if (error != null) ErrorText(error!),
              const SizedBox(height: 16),
              GlassButton(label: 'Enter station ID', icon: Icons.keyboard_alt_outlined, onPressed: manual),
            ],
          ),
        ),
      ),
    );
  }
}

class ConfirmRentalScreen extends StatefulWidget {
  const ConfirmRentalScreen({super.key, required this.station, required this.pricing});
  final Station station;
  final RentalPricing pricing;
  @override
  State<ConfirmRentalScreen> createState() => _ConfirmRentalScreenState();
}

class _ConfirmRentalScreenState extends State<ConfirmRentalScreen> {
  final form = GlobalKey<FormState>();
  final email = TextEditingController();
  final promo = TextEditingController();
  int count = 1;
  bool consent = false;
  bool sending = false;
  String? error;

  @override
  void initState() {
    super.initState();
    final e = Supabase.instance.client.auth.currentUser?.email;
    if (e != null && !e.endsWith('@mobile.zapnivo.com')) email.text = e;
  }

  @override
  void dispose() {
    email.dispose();
    promo.dispose();
    super.dispose();
  }

  Future<void> checkout() async {
    if (!form.currentState!.validate() || sending) return;
    if (!consent) {
      setState(() => error = 'Accept the rental terms to continue.');
      return;
    }
    final app = AppScope.of(context);
    final navigator = Navigator.of(context);
    setState(() {
      sending = true;
      error = null;
    });
    try {
      await app.refreshRentals();
      final known = (app.rentals ?? const <Rental>[]).map((r) => r.reference).toSet();
      final url = await app.api.createCheckout(stationId: widget.station.id, email: email.text, bankCount: count, promoCode: promo.text);
      if (!await launchUrl(url, mode: LaunchMode.inAppBrowserView)) {
        throw const ApiException('Payment page could not open. Please try again.');
      }
      if (!mounted) return;
      navigator.pushReplacement(MaterialPageRoute<void>(builder: (_) => PaymentPendingScreen(knownReferences: known, checkoutUrl: url)));
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.pricing;
    final max = (widget.station.readyBanks ?? 3).clamp(1, 3);
    return Scaffold(
      appBar: AppBar(title: const Text('Confirm Rental')),
      body: Form(
        key: form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 36),
          children: [
            Glass(
              child: Row(
                children: [
                  const Icon(Icons.bolt_rounded, color: lime, size: 30),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(widget.station.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                        Text(widget.station.address, style: const TextStyle(color: muted, fontSize: 13)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            Glass(
              tint: lime,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Row(children: [Icon(Icons.check_circle, color: lime), SizedBox(width: 8), Text('Standard Rental', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17))]),
                  const SizedBox(height: 10),
                  Text('${money(p.firstHourCents)} first hour', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18)),
                  Text('${money(p.additionalHourCents)} each additional hour', style: const TextStyle(color: muted)),
                  const SizedBox(height: 6),
                  Text('Return within ${p.nonReturnAfterHours} hours. Non-return fee: ${money(p.nonReturnMaxCents)}.', style: const TextStyle(color: muted, fontSize: 13, height: 1.4)),
                ],
              ),
            ),
            const SizedBox(height: 18),
            TextFormField(
              controller: email,
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              decoration: const InputDecoration(labelText: 'Email for your receipt', prefixIcon: Icon(Icons.mail_outline)),
              validator: (v) => v != null && RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(v.trim()) ? null : 'Enter a valid email address',
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(
              initialValue: count,
              dropdownColor: inkSoft,
              decoration: const InputDecoration(labelText: 'Power banks', prefixIcon: Icon(Icons.battery_charging_full)),
              items: [for (var n = 1; n <= max; n++) DropdownMenuItem(value: n, child: Text('$n'))],
              onChanged: (v) => setState(() => count = v ?? 1),
            ),
            const SizedBox(height: 12),
            TextFormField(controller: promo, maxLength: 40, decoration: const InputDecoration(labelText: 'Promo code (optional)', prefixIcon: Icon(Icons.sell_outlined))),
            CheckboxListTile(
              value: consent,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text('I agree to the rental terms and have read the privacy policy.', style: TextStyle(fontSize: 14)),
              onChanged: (v) => setState(() => consent = v ?? false),
            ),
            Wrap(
              children: [
                TextButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const InAppPage(title: 'Rental terms', url: '$siteBase/legal/rental-terms'))), child: const Text('Rental terms')),
                TextButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const InAppPage(title: 'Privacy policy', url: '$siteBase/legal/privacy'))), child: const Text('Privacy policy')),
              ],
            ),
            if (error != null) ErrorText(error!),
            const SizedBox(height: 12),
            PrimaryButton(label: 'Confirm Rental', icon: Icons.lock_outline, loading: sending, onPressed: checkout),
            const SizedBox(height: 12),
            const Text(
              'You will choose your payment method on our secure Stripe payment page (card, Apple Pay or Google Pay where available). Zapnivo never sees your card number. A rental starts only after the station confirms dispensing.',
              textAlign: TextAlign.center,
              style: TextStyle(color: muted, fontSize: 12, height: 1.4),
            ),
          ],
        ),
      ),
    );
  }
}

/// Waits for the server to confirm payment + dispense, then moves on.
class PaymentPendingScreen extends StatefulWidget {
  const PaymentPendingScreen({super.key, required this.knownReferences, required this.checkoutUrl});
  final Set<String> knownReferences;
  final Uri checkoutUrl;
  @override
  State<PaymentPendingScreen> createState() => _PaymentPendingScreenState();
}

class _PaymentPendingScreenState extends State<PaymentPendingScreen> with WidgetsBindingObserver {
  Timer? timer;
  bool checking = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    timer = Timer.periodic(const Duration(seconds: 4), (_) => check());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    timer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) check();
  }

  Future<void> check() async {
    if (checking || !mounted) return;
    checking = true;
    final app = AppScope.of(context);
    final navigator = Navigator.of(context);
    await app.refreshRentals();
    checking = false;
    final fresh = app.rentals?.where((r) => r.isActive && !widget.knownReferences.contains(r.reference)).firstOrNull;
    if (fresh != null && mounted) {
      timer?.cancel();
      navigator.pushReplacement(MaterialPageRoute<void>(builder: (_) => PaymentSuccessScreen(rental: fresh)));
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Payment'), leading: CloseButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst))),
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            const Spacer(),
            const SizedBox(width: 64, height: 64, child: CircularProgressIndicator(color: lime, strokeWidth: 4)),
            const SizedBox(height: 28),
            const Text('Waiting for payment', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w900)),
            const SizedBox(height: 10),
            const Text(
              'Complete payment in your browser. Once the station confirms your power bank was dispensed, your rental starts here automatically.',
              textAlign: TextAlign.center,
              style: TextStyle(color: muted, height: 1.5),
            ),
            const Spacer(),
            PrimaryButton(label: 'I have paid, check status', onPressed: check),
            const SizedBox(height: 10),
            GlassButton(label: 'Reopen payment page', icon: Icons.open_in_new, onPressed: () => launchUrl(widget.checkoutUrl, mode: LaunchMode.inAppBrowserView)),
            const SizedBox(height: 6),
            TextButton(
              onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst),
              child: const Text('Back to home', style: TextStyle(color: muted)),
            ),
          ],
        ),
      ),
    ),
  );
}

class ActiveRentalPanel extends StatefulWidget {
  const ActiveRentalPanel({super.key, required this.rental});
  final Rental rental;
  @override
  State<ActiveRentalPanel> createState() => _ActiveRentalPanelState();
}

class _ActiveRentalPanelState extends State<ActiveRentalPanel> {
  Timer? timer;
  @override
  void initState() {
    super.initState();
    timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final r = widget.rental;
    final price = AppScope.of(context).pricing;
    final elapsed = r.startedAt == null ? null : DateTime.now().difference(r.startedAt!);
    int? estimate;
    if (elapsed != null && price != null) {
      final hours = (elapsed.inMinutes / 60).ceil().clamp(1, 1000000);
      estimate = price.firstHourCents + (hours - 1) * price.additionalHourCents;
    }
    return Glass(
      tint: lime,
      padding: const EdgeInsets.all(22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.battery_charging_full_rounded, color: lime, size: 30),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Portable Charger', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                    Text('Rental ID: ${r.reference}', style: const TextStyle(color: muted, fontSize: 12)),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 22),
          Center(
            child: Column(
              children: [
                Text(elapsed == null ? '--:--:--' : formatDuration(elapsed), style: const TextStyle(fontSize: 46, fontWeight: FontWeight.w900, letterSpacing: -1, fontFeatures: [FontFeature.tabularFigures()])),
                const Text('Time elapsed', style: TextStyle(color: muted)),
              ],
            ),
          ),
          const SizedBox(height: 18),
          _line('Station', r.venue),
          _line('Power banks', '${r.bankCount}'),
          _line('Status', r.stateLabel),
          if (r.startedAt != null) _line('Start time', formatTime(r.startedAt!)),
          if (price != null) _line('Rate', '${money(price.firstHourCents)} first hour / ${money(price.additionalHourCents)} additional'),
          if (estimate != null) _line('Estimated so far', '${money(estimate)} per bank'),
          if (r.returnDeadline != null) _deadline(r, price),
          const SizedBox(height: 18),
          PrimaryButton(
            label: 'Return Charger',
            icon: Icons.keyboard_return,
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ReturnLocationsScreen())),
          ),
        ],
      ),
    );
  }

  Widget _deadline(Rental r, RentalPricing? price) {
    final left = r.returnDeadline!.difference(DateTime.now());
    final over = left.isNegative;
    final total = r.startedAt == null ? null : r.returnDeadline!.difference(r.startedAt!).inSeconds;
    final used = total == null || total <= 0 ? null : (1 - left.inSeconds / total).clamp(0.0, 1.0);
    final urgent = over || left.inHours < 2;
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(over ? 'Past return deadline' : 'Return within', style: TextStyle(color: urgent ? danger : muted, fontWeight: FontWeight.w700)),
              Text(over ? formatDuration(-left) : formatDuration(left), style: TextStyle(color: urgent ? danger : Colors.white, fontWeight: FontWeight.w900, fontFeatures: const [FontFeature.tabularFigures()])),
            ],
          ),
          if (used != null) ...[
            const SizedBox(height: 8),
            ClipRRect(borderRadius: BorderRadius.circular(8), child: LinearProgressIndicator(value: over ? 1 : used, minHeight: 6, backgroundColor: Colors.white12, color: urgent ? danger : lime)),
          ],
          if (over && price != null)
            Padding(padding: const EdgeInsets.only(top: 8), child: Text('The non-return fee of ${money(price.nonReturnMaxCents)} may be charged. Return the power bank now.', style: const TextStyle(color: danger, height: 1.4, fontSize: 13))),
        ],
      ),
    );
  }

  Widget _line(String a, String b) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 4),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(a, style: const TextStyle(color: muted)),
        const SizedBox(width: 16),
        Expanded(child: Text(b, textAlign: TextAlign.right, style: const TextStyle(fontWeight: FontWeight.w700))),
      ],
    ),
  );
}

class ReturnLocationsScreen extends StatelessWidget {
  const ReturnLocationsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final list = app.sortedByDistance();
    return Scaffold(
      appBar: AppBar(title: const Text('Return Locations')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 36),
        children: [
          const Text('Return your charger to any live Zapnivo station.', style: TextStyle(color: muted)),
          const SizedBox(height: 14),
          if (list.isEmpty)
            const StateCard(icon: Icons.location_off_outlined, title: 'No stations listed', body: 'Station locations could not be loaded. Pull to refresh from the map tab.')
          else
            for (final s in list)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Glass(
                  radius: 20,
                  child: Row(
                    children: [
                      const Icon(Icons.bolt_rounded, color: lime),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(s.name, style: const TextStyle(fontWeight: FontWeight.w800)),
                            Text([if (app.distanceMiles(s) != null) distanceLabel(app.distanceMiles(s)), s.address].join(' · '), style: const TextStyle(color: muted, fontSize: 13)),
                          ],
                        ),
                      ),
                      if (s.lat != null) IconButton(onPressed: () => openDirections(s), icon: const Icon(Icons.directions, color: lime), tooltip: 'Directions'),
                    ],
                  ),
                ),
              ),
          const SizedBox(height: 12),
          PrimaryButton(
            label: 'Scan Return Dock',
            icon: Icons.qr_code_scanner,
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ScanScreen.returnDock())),
          ),
        ],
      ),
    );
  }
}

class ReturnProgressScreen extends StatefulWidget {
  const ReturnProgressScreen({super.key, required this.dockId});
  final String dockId;
  @override
  State<ReturnProgressScreen> createState() => _ReturnProgressScreenState();
}

class _ReturnProgressScreenState extends State<ReturnProgressScreen> {
  Timer? timer;
  String? activeRef;
  bool slow = false;
  late final DateTime started = DateTime.now();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      activeRef = AppScope.of(context).activeRental?.reference;
      check();
      timer = Timer.periodic(const Duration(seconds: 3), (_) => check());
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  Future<void> check() async {
    if (!mounted) return;
    final app = AppScope.of(context);
    final navigator = Navigator.of(context);
    await app.refreshRentals();
    final ref = activeRef;
    if (ref == null) return;
    final done = app.rentals?.where((r) => r.reference == ref && !r.isActive).firstOrNull;
    if (done != null && mounted) {
      timer?.cancel();
      navigator.pushReplacement(MaterialPageRoute<void>(builder: (_) => ReturnSuccessScreen(rental: done)));
    } else if (mounted && DateTime.now().difference(started).inSeconds > 60 && !slow) {
      setState(() => slow = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasActive = activeRef != null;
    return Scaffold(
      appBar: AppBar(title: const Text('Return Charger')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Spacer(),
              Glass(radius: 50, padding: const EdgeInsets.all(32), child: const Icon(Icons.download_rounded, color: lime, size: 72)),
              const SizedBox(height: 26),
              Text(hasActive ? 'Insert your power bank' : 'No active rental', style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900)),
              const SizedBox(height: 10),
              Text(
                hasActive
                    ? 'Dock ${widget.dockId}: push your power bank into an open slot until it clicks. Your return is confirmed by the station and appears here automatically.'
                    : 'There is no rental to return. If you just paid, wait a moment and check the Rentals tab.',
                textAlign: TextAlign.center,
                style: const TextStyle(color: muted, height: 1.5),
              ),
              if (hasActive) ...[
                const SizedBox(height: 24),
                const CircularProgressIndicator(color: lime),
              ],
              if (slow)
                const Padding(
                  padding: EdgeInsets.only(top: 18),
                  child: Text('Taking longer than usual? Make sure the bank is fully seated, or contact support from the Support tab.', textAlign: TextAlign.center, style: TextStyle(color: danger, height: 1.4)),
                ),
              const Spacer(),
              GlassButton(label: hasActive ? 'Cancel' : 'Back', onPressed: () => Navigator.of(context).pop()),
            ],
          ),
        ),
      ),
    );
  }
}

