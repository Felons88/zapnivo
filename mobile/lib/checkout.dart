import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_stripe/flutter_stripe.dart' as stripe;
import 'package:material_ui/material_ui.dart' as mui;
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

import 'animations.dart';
import 'api.dart';
import 'app_state.dart';
import 'stations.dart';
import 'success.dart';
import 'support.dart';
import 'theme.dart';
import 'widgets.dart';

const _emailRe = r'^[^\s@]+@[^\s@]+\.[^\s@]+$';

/* ───────────────────────── progress indicator ───────────────────────── */

/// Three animated stages: Rental → Payment → Confirmation. Completed steps get a
/// drawn checkmark, the active step is lime, upcoming steps stay muted.
class CheckoutProgress extends StatelessWidget {
  const CheckoutProgress({super.key, required this.current});
  static const labels = ['Rental', 'Payment', 'Confirmation'];
  final int current;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (var i = 0; i < labels.length; i++) ...[
          _step(context, i),
          if (i < labels.length - 1) _connector(i),
        ],
      ],
    );
  }

  Widget _connector(int after) => Expanded(
        child: Padding(
          padding: const EdgeInsets.only(bottom: 20, left: 6, right: 6),
          child: SizedBox(
            height: 2,
            child: Stack(
              children: [
                Container(color: Colors.white.withValues(alpha: 0.14)),
                AnimatedFractionallySizedBox(
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeInOut,
                  widthFactor: current > after ? 1 : 0,
                  alignment: Alignment.centerLeft,
                  child: Container(color: limeAccent),
                ),
              ],
            ),
          ),
        ),
      );

  Widget _step(BuildContext context, int i) {
    final done = i < current;
    final active = i == current;
    final color = done || active ? lime : muted;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedScale(
          scale: active ? 1.08 : 1,
          duration: const Duration(milliseconds: 280),
          curve: Curves.easeInOut,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeInOut,
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: done ? lime : (active ? lime.withValues(alpha: 0.16) : Colors.white.withValues(alpha: 0.06)),
              border: Border.all(color: done ? lime : color.withValues(alpha: active ? 1 : 0.35), width: done ? 0 : 1.6),
            ),
            child: Center(
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 250),
                child: done
                    ? const Icon(Icons.check_rounded, key: ValueKey('check'), color: ink, size: 19)
                    : Icon(
                        i == 0 ? Icons.shopping_cart_outlined : i == 1 ? Icons.credit_card_outlined : Icons.check_circle_outline_rounded,
                        key: ValueKey('icon$i'),
                        color: color,
                        size: 17,
                      ),
              ),
            ),
          ),
        ),
        const SizedBox(height: 6),
        AnimatedDefaultTextStyle(
          duration: const Duration(milliseconds: 250),
          style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: done || active ? lime : muted),
          child: Text(labels[i]),
        ),
      ],
    );
  }
}

/* ───────────────────────── kiosk illustration ───────────────────────── */

/// Original vector render of the approved Zapnivo kiosk: white upright
/// eight-slot cabinet, dark screen with Zapnivo branding, black power banks
/// with integrated cables, lime progress indicators, purple/cyan accent
/// lighting on a dark navy field. `dispense` (0..1) slides the active slot's
/// bank slowly outward — always driven by backend stage, never a timer guess.
class KioskIllustration extends StatelessWidget {
  const KioskIllustration({
    super.key,
    this.size = 120,
    this.readySlots = 3,
    this.dispense = 0,
    this.litSlot = -1,
    this.ready = false,
    this.dimmed = false,
  });
  final double size;

  /// How many of the 8 slots contain a bank (static card usage).
  final int readySlots;

  /// Eject progress 0..1 for the active slot's bank.
  final double dispense;

  /// Slot index (0..7) currently illuminated/acting; -1 = none.
  final int litSlot;

  /// Hardware-confirmed release — draws the lime check badge.
  final bool ready;

  /// Dim the cabinet (failed / unknown-outcome states).
  final bool dimmed;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size * 1.35,
        child: CustomPaint(
          painter: _KioskPainter(
            filledSlots: readySlots.clamp(0, 8),
            dispense: dispense,
            litSlot: litSlot,
            ready: ready,
            dimmed: dimmed,
          ),
        ),
      );
}

class _KioskPainter extends CustomPainter {
  _KioskPainter({required this.filledSlots, required this.dispense, required this.litSlot, required this.ready, required this.dimmed});
  final int filledSlots;
  final double dispense;
  final int litSlot;
  final bool ready;
  final bool dimmed;

  static const _cyan = Color(0xFF4CC9F0);
  static const _purple = Color(0xFF9B5DE5);
  static const _navy = Color(0xFF10182B);
  static const _bank = Color(0xFF14181F);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;

    // Ambient accent lighting — purple top-left, cyan bottom-right.
    _glow(canvas, Offset(w * 0.1, h * 0.08), w * 0.55, _purple.withValues(alpha: dimmed ? 0.05 : 0.14));
    _glow(canvas, Offset(w * 0.95, h * 0.9), w * 0.5, _cyan.withValues(alpha: dimmed ? 0.05 : 0.13));

    // White cabinet.
    final body = RRect.fromRectAndRadius(Rect.fromLTWH(0, 0, w, h * 0.96), Radius.circular(w * 0.08));
    canvas.drawRRect(
      body,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: dimmed
              ? const [Color(0xFF8B93A3), Color(0xFF6E7686)]
              : const [Color(0xFFFDFEFF), Color(0xFFC9D3E3)],
        ).createShader(body.outerRect),
    );
    canvas.drawRRect(body, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..color = Colors.white.withValues(alpha: 0.55));

    // Screen — dark navy with Zapnivo brand.
    final screen = RRect.fromRectAndRadius(Rect.fromLTWH(w * 0.09, h * 0.04, w * 0.82, h * 0.185), Radius.circular(w * 0.05));
    canvas.drawRRect(screen, Paint()..color = _navy);
    canvas.drawRRect(screen, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = _cyan.withValues(alpha: 0.35));
    _bolt(canvas, Offset(w * 0.24, h * 0.132), w * 0.055, lime);
    _text(canvas, 'ZAPNIVO', Offset(w * 0.33, h * 0.088), w * 0.075, Colors.white, FontWeight.w800);
    _text(canvas, 'POWER UP & GO', Offset(w * 0.335, h * 0.148), w * 0.038, lime.withValues(alpha: 0.85), FontWeight.w600);

    // Slot grid — 2 columns × 4 rows.
    const cols = 2, rows = 4;
    final gridL = w * 0.09, gridW = w * 0.82;
    final gridT = h * 0.27, gridH = h * 0.54;
    final gapX = w * 0.045, gapY = h * 0.018;
    final slotW = (gridW - gapX) / cols, slotH = (gridH - gapY * (rows - 1)) / rows;
    final active = litSlot.clamp(-1, 7);
    for (var i = 0; i < 8; i++) {
      final col = i % cols, row = i ~/ cols;
      final x = gridL + col * (slotW + gapX);
      final y = gridT + row * (slotH + gapY);
      final slot = RRect.fromRectAndRadius(Rect.fromLTWH(x, y, slotW, slotH), Radius.circular(w * 0.03));
      canvas.drawRRect(slot, Paint()..color = _navy.withValues(alpha: dimmed ? 0.55 : 0.92));
      final lit = i == active && !dimmed;
      canvas.drawRRect(slot, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = lit ? 2 : 1
        ..color = lit ? lime : _cyan.withValues(alpha: 0.4));
      if (lit) {
        canvas.drawRRect(
          slot,
          Paint()
            ..color = lime.withValues(alpha: 0.10 + 0.08 * math.sin(dispense * math.pi))
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 6),
        );
      }
      final occupied = i < filledSlots && !(i == active && dispense > 0.02);
      if (occupied) _drawBank(canvas, Rect.fromLTWH(x + slotW * 0.1, y + slotH * 0.12, slotW * 0.8, slotH * 0.76), w);
    }

    // The ejecting bank rides out of its slot toward the pickup tray — the
    // ONLY element `dispense` moves, and only when the backend says so.
    if (active >= 0 && dispense > 0.02 && !dimmed) {
      final col = active % cols, row = active ~/ cols;
      final sx = gridL + col * (slotW + gapX);
      final sy = gridT + row * (slotH + gapY);
      final t = Curves.easeInOut.transform(dispense.clamp(0.0, 1.0));
      var rect = Rect.fromLTWH(sx + slotW * 0.1, sy + slotH * 0.12, slotW * 0.8, slotH * 0.76);
      // Slide down toward the pickup tray + grow slightly toward the viewer.
      final trayY = h * 0.885;
      rect = Rect.fromLTWH(
        rect.left - (rect.width * 0.25) * t,
        rect.top + (trayY - rect.top) * t,
        rect.width * (1 + 0.5 * t),
        rect.height * (1 + 0.5 * t),
      );
      final halo = rect.inflate(w * 0.09);
      canvas.drawRRect(
        RRect.fromRectAndRadius(halo, Radius.circular(w * 0.06)),
        Paint()..color = lime.withValues(alpha: 0.16 * math.sin(t * math.pi) + (t >= 1 ? 0.12 : 0))
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 10),
      );
      _drawBank(canvas, rect, w * (1 + 0.4 * t));
    }

    // Pickup tray recess.
    final tray = RRect.fromRectAndRadius(Rect.fromLTWH(w * 0.14, h * 0.85, w * 0.72, h * 0.075), Radius.circular(w * 0.04));
    canvas.drawRRect(tray, Paint()..color = _navy.withValues(alpha: dimmed ? 0.4 : 0.85));
    canvas.drawRRect(tray, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = Colors.white.withValues(alpha: 0.18));

    // Lime progress dots — eight, lit by eject progress.
    final litDots = ready ? 8 : (dispense * 8).floor();
    for (var i = 0; i < 8; i++) {
      final cx = w * 0.2 + (w * 0.6) * (i / 7);
      canvas.drawCircle(
        Offset(cx, h * 0.935),
        w * 0.012,
        Paint()..color = i < litDots ? lime : Colors.white.withValues(alpha: 0.25),
      );
    }

    // Ready badge — lime check, top-right of the cabinet.
    if (ready && !dimmed) {
      final c = Offset(w * 0.86, h * 0.115);
      canvas.drawCircle(c, w * 0.075, Paint()..color = lime);
      final p = Path()
        ..moveTo(c.dx - w * 0.032, c.dy)
        ..lineTo(c.dx - w * 0.008, c.dy + w * 0.026)
        ..lineTo(c.dx + w * 0.038, c.dy - w * 0.028);
      canvas.drawPath(p, Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = w * 0.016
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..color = _navy);
    }
  }

  void _drawBank(Canvas canvas, Rect rect, double w) {
    final bank = RRect.fromRectAndRadius(rect, Radius.circular(w * 0.035));
    canvas.drawRRect(bank, Paint()..color = _bank);
    canvas.drawRRect(bank, Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..color = Colors.white.withValues(alpha: 0.28));
    // Integrated cable loop along the right edge.
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(rect.right - rect.width * 0.14, rect.top + rect.height * 0.18, rect.width * 0.08, rect.height * 0.64),
        Radius.circular(rect.width * 0.04),
      ),
      Paint()..color = lime.withValues(alpha: 0.55),
    );
    _bolt(canvas, Offset(rect.center.dx - rect.width * 0.06, rect.center.dy), rect.height * 0.16, lime);
  }

  void _glow(Canvas canvas, Offset c, double r, Color color) {
    canvas.drawCircle(c, r, Paint()
      ..shader = RadialGradient(colors: [color, color.withValues(alpha: 0)]).createShader(Rect.fromCircle(center: c, radius: r)));
  }

  void _text(Canvas canvas, String s, Offset at, double size, Color color, FontWeight weight) {
    final tp = TextPainter(
      text: TextSpan(text: s, style: TextStyle(fontSize: size, fontWeight: weight, color: color, letterSpacing: size * 0.12)),
      textDirection: TextDirection.ltr,
    )..layout();
    tp.paint(canvas, at);
  }

  void _bolt(Canvas canvas, Offset c, double s, Color color) {
    final path = Path()
      ..moveTo(c.dx + s * 0.15, c.dy - s)
      ..lineTo(c.dx - s * 0.55, c.dy + s * 0.15)
      ..lineTo(c.dx - s * 0.05, c.dy + s * 0.15)
      ..lineTo(c.dx - s * 0.15, c.dy + s)
      ..lineTo(c.dx + s * 0.55, c.dy - s * 0.15)
      ..lineTo(c.dx + s * 0.05, c.dy - s * 0.15)
      ..close();
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_KioskPainter old) =>
      old.filledSlots != filledSlots || old.dispense != dispense || old.litSlot != litSlot || old.ready != ready || old.dimmed != dimmed;
}

/* ─────────────────────── station validation screen ─────────────────────── */

/// After a scan: staged validation — find the station, confirm inventory, load
/// pricing — with real progress, then hands off to checkout. Offline or empty
/// stations get an honest retry, never a faked "online".
class StationValidationScreen extends StatefulWidget {
  const StationValidationScreen({super.key, required this.stationId});
  final String stationId;
  @override
  State<StationValidationScreen> createState() => _StationValidationScreenState();
}

class _StationValidationScreenState extends State<StationValidationScreen> {
  int stage = 0; // 0 finding, 1 checking inventory, 2 done
  String? error;

  @override
  void initState() {
    super.initState();
    validate();
  }

  Future<void> validate() async {
    setState(() {
      stage = 0;
      error = null;
    });
    try {
      final d = await AppScope.of(context).api.getStation(widget.stationId);
      if (!mounted) return;
      setState(() => stage = 1);
      if (d.pricing == null) throw const ApiException('Rentals are not open yet. Nothing has been charged.');
      if (!stationAvailable(d.station)) throw const ApiException('No chargers are ready at this station right now.');
      if (!mounted) return;
      setState(() => stage = 2);
      // One short beat so the completed checklist is visible before navigation.
      await Future<void>.delayed(const Duration(milliseconds: 350));
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(builder: (_) => ConfirmRentalScreen(station: d.station, pricing: d.pricing!)),
      );
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final failed = error != null;
    return Scaffold(
      appBar: AppBar(title: const Text('Station Check')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Spacer(),
              Stack(
                alignment: Alignment.center,
                children: [
                  SizedBox(
                    width: 132,
                    height: 132,
                    child: failed
                        ? const SizedBox.shrink()
                        : CircularProgressIndicator(color: lime, strokeWidth: 3, backgroundColor: Colors.white.withValues(alpha: 0.1)),
                  ),
                  AnimatedScale(
                    scale: failed ? 1 : 1.0,
                    duration: const Duration(milliseconds: 300),
                    child: Container(
                      width: 96,
                      height: 96,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: (failed ? danger : lime).withValues(alpha: 0.12),
                        border: Border.all(color: (failed ? danger : lime).withValues(alpha: 0.5)),
                      ),
                      child: Icon(failed ? Icons.error_outline_rounded : Icons.bolt_rounded, color: failed ? danger : lime, size: 46),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 30),
              Text(failed ? 'Station unavailable' : 'Checking station…', style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w900)),
              const SizedBox(height: 18),
              if (!failed) ...[
                _stage(0, 'Finding station ${widget.stationId}'),
                _stage(1, 'Checking power banks & pricing'),
                _stage(2, 'Ready'),
              ] else ...[
                Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: muted, height: 1.5)),
                const SizedBox(height: 22),
                PrimaryButton(label: 'Try again', icon: Icons.refresh_rounded, onPressed: validate),
                const SizedBox(height: 10),
                GlassButton(label: 'Scan another station', icon: Icons.qr_code_scanner, onPressed: () => Navigator.of(context).pop()),
              ],
              const Spacer(),
            ],
          ),
        ),
      ),
    );
  }

  Widget _stage(int i, String label) {
    final done = stage > i;
    final active = stage == i;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 250),
            child: done
                ? const Icon(Icons.check_circle_rounded, key: ValueKey('d'), color: lime, size: 18)
                : Icon(active ? Icons.radio_button_checked : Icons.circle_outlined, key: ValueKey('p$i'), color: active ? lime : muted, size: 18),
          ),
          const SizedBox(width: 8),
          AnimatedDefaultTextStyle(
            duration: const Duration(milliseconds: 250),
            style: TextStyle(color: done || active ? Colors.white : muted, fontWeight: FontWeight.w600),
            child: Text(label),
          ),
        ],
      ),
    );
  }
}

/* ─────────────────────────── quantity stepper ─────────────────────────── */

class QuantityStepper extends StatefulWidget {
  const QuantityStepper({super.key, required this.count, required this.max, required this.onChanged, this.busy = false});
  final int count;
  final int max;
  final ValueChanged<int> onChanged;
  final bool busy;

  @override
  State<QuantityStepper> createState() => _QuantityStepperState();
}

class _QuantityStepperState extends State<QuantityStepper> {
  int? prev;

  @override
  void didUpdateWidget(QuantityStepper old) {
    super.didUpdateWidget(old);
    if (old.count != widget.count) prev = old.count;
  }

  @override
  Widget build(BuildContext context) {
    final increased = prev != null && widget.count > prev!;
    return Row(
      children: [
        _btn(Icons.remove_rounded, widget.count > 1 && !widget.busy ? () => widget.onChanged(widget.count - 1) : null),
        SizedBox(
          width: 56,
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 190),
            transitionBuilder: (child, anim) => SlideTransition(
              position: Tween(begin: Offset(0, child.key == ValueKey(widget.count) ? (increased ? 0.5 : -0.5) : (increased ? -0.5 : 0.5)), end: Offset.zero).animate(anim),
              child: FadeTransition(opacity: anim, child: child),
            ),
            child: Text('${widget.count}', key: ValueKey(widget.count), textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900, fontFeatures: [FontFeature.tabularFigures()])),
          ),
        ),
        _btn(Icons.add_rounded, widget.count < widget.max && !widget.busy ? () => widget.onChanged(widget.count + 1) : null),
      ],
    );
  }

  Widget _btn(IconData icon, VoidCallback? onTap) => Pressable(
        enabled: onTap != null,
        child: InkResponse(
          onTap: onTap == null
              ? null
              : () {
                  HapticFeedback.selectionClick();
                  onTap();
                },
          radius: 24,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: onTap == null ? muted.withValues(alpha: 0.3) : lime, width: 1.4),
              color: onTap == null ? Colors.transparent : lime.withValues(alpha: 0.12),
            ),
            child: Icon(icon, size: 20, color: onTap == null ? muted.withValues(alpha: 0.4) : lime),
          ),
        ),
      );
}

/* ─────────────────────── confirm rental (checkout) ─────────────────────── */

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
  bool applyingPromo = false;
  QuotePromo? appliedPromo;
  String? error;
  String? promoError;
  late final _termsTap = TapGestureRecognizer()..onTap = () => _openDoc('Rental terms', '$siteBase/legal/rental-terms');
  late final _privacyTap = TapGestureRecognizer()..onTap = () => _openDoc('Privacy policy', '$siteBase/legal/privacy');

  void _openDoc(String title, String url) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => InAppPage(title: title, url: url)));

  int get maxCount => (widget.station.readyBanks ?? 3).clamp(1, 3);
  int get firstHourEstimate => widget.pricing.firstHourCents * count;
  int get hold => widget.pricing.holdCentsPerBank * count;
  bool get emailOk => RegExp(_emailRe).hasMatch(email.text.trim());
  bool get ready => emailOk && consent && !sending;

  @override
  void initState() {
    super.initState();
    try {
      final e = Supabase.instance.client.auth.currentUser?.email;
      if (e != null && !e.endsWith('@mobile.zapnivo.com')) email.text = e;
    } catch (_) {
      // Supabase may be unavailable in tests — the renter can still type an email.
    }
    email.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    email.dispose();
    promo.dispose();
    _termsTap.dispose();
    _privacyTap.dispose();
    super.dispose();
  }

  void setCount(int n) {
    setState(() => count = n);
    if (appliedPromo != null) applyPromo(quiet: true);
  }

  Future<void> applyPromo({bool quiet = false}) async {
    final code = promo.text.trim();
    if (code.isEmpty || applyingPromo) return;
    final app = AppScope.of(context);
    setState(() {
      applyingPromo = true;
      promoError = null;
      if (!quiet) appliedPromo = null;
    });
    try {
      final q = await app.api.checkoutQuote(stationId: widget.station.id, bankCount: count, promoCode: code);
      if (!mounted) return;
      setState(() {
        appliedPromo = q.promo != null && q.promo!.valid ? q.promo : null;
        promoError = q.promo != null && !q.promo!.valid ? 'Invalid or expired code.' : null;
      });
      if (appliedPromo != null && !quiet) {
        HapticFeedback.lightImpact();
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Promo code applied!')));
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => promoError = quiet ? null : e.message);
    } finally {
      if (mounted) setState(() => applyingPromo = false);
    }
  }

  void clearPromo() => setState(() {
        promo.clear();
        appliedPromo = null;
        promoError = null;
      });

  Future<void> pay() async {
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
      // Revalidate inventory, pricing and the promo server-side immediately
      // before creating the Stripe session.
      final q = await app.api.checkoutQuote(
        stationId: widget.station.id,
        bankCount: count,
        promoCode: appliedPromo != null ? appliedPromo!.code : promo.text,
      );
      if (q.readyBanks < count) {
        throw ApiException(q.readyBanks == 0
            ? 'No chargers are ready now. Try another station.'
            : 'Only ${q.readyBanks} charger(s) are ready now. Lower the quantity or try another station.');
      }
      await app.refreshRentals();
      final known = (app.rentals ?? const <Rental>[]).map((r) => r.reference).toSet();
      final init = await app.api.createCheckout(
        stationId: widget.station.id,
        email: email.text,
        bankCount: count,
        promoCode: appliedPromo?.code,
      );
      if (init.isSheet) {
        // In-app PaymentSheet: card entry + Google Pay, never leaving the app.
        try {
          stripe.Stripe.publishableKey = init.publishableKey!;
          await stripe.Stripe.instance.initPaymentSheet(
            paymentSheetParameters: stripe.SetupPaymentSheetParameters(
              paymentIntentClientSecret: init.paymentIntentClientSecret!,
              customerId: init.customerId!,
              customerEphemeralKeySecret: init.ephemeralKey!,
              merchantDisplayName: init.merchantDisplayName,
              style: mui.ThemeMode.dark,
              googlePay: const stripe.PaymentSheetGooglePay(merchantCountryCode: 'US', currencyCode: 'USD', testEnv: kDebugMode),
              applePay: const stripe.PaymentSheetApplePay(merchantCountryCode: 'US'),
            ),
          );
          await stripe.Stripe.instance.presentPaymentSheet();
        } on stripe.StripeException catch (e) {
          if (e.error.code == stripe.FailureCode.Canceled) return; // user backed out — no banner
          throw ApiException(e.error.localizedMessage ?? 'Payment failed. Nothing has been charged.');
        }
      } else {
        if (!await launchUrl(init.hostedUrl!, mode: LaunchMode.inAppBrowserView)) {
          throw const ApiException('Payment page could not open. Please try again.');
        }
      }
      if (!mounted) return;
      navigator.pushReplacement(MaterialPageRoute<void>(
        builder: (_) => DispensingScreen(knownReferences: known, checkoutUrl: init.hostedUrl, stationName: widget.station.name, bankCount: count),
      ));
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.pricing;
    final s = widget.station;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 20, 0),
              child: Row(
                children: [
                  IconButton(onPressed: () => Navigator.of(context).maybePop(), icon: const Icon(Icons.arrow_back_rounded)),
                  const Expanded(
                    child: Column(
                      children: [
                        Text('Complete Your Rental', style: TextStyle(fontSize: 19, fontWeight: FontWeight.w900, letterSpacing: -0.4)),
                        SizedBox(height: 2),
                        Text('Secure • Fast • Pick Up & Charge', style: TextStyle(color: muted, fontSize: 11.5)),
                      ],
                    ),
                  ),
                  const Icon(Icons.shield_outlined, color: lime, size: 20),
                ],
              ),
            ),
            const Padding(padding: EdgeInsets.fromLTRB(28, 6, 28, 0), child: CheckoutProgress(current: 0)),
            Expanded(
              child: Form(
                key: form,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
                  keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
                  children: stagger([
                    _stationCard(s),
                    const SizedBox(height: 10),
                    _planCard(p),
                    const SizedBox(height: 12),
                    _details(),
                    const SizedBox(height: 12),
                    _promo(),
                    const SizedBox(height: 12),
                    _summary(p),
                    const SizedBox(height: 10),
                    _terms(),
                    if (error != null) ErrorText(error!),
                  ], step: const Duration(milliseconds: 60)),
                ),
              ),
            ),
            _footer(),
          ],
        ),
      ),
    );
  }

  Widget _card({required Widget child, Color? border, EdgeInsetsGeometry padding = const EdgeInsets.all(14)}) => AnimatedContainer(
        duration: const Duration(milliseconds: 250),
        decoration: BoxDecoration(
          color: elevated,
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: border ?? hairline),
        ),
        padding: padding,
        child: child,
      );

  Widget _stationCard(Station s) => _card(
        child: Row(
          children: [
            KioskIllustration(size: 52, readySlots: (s.readyBanks ?? 0).clamp(0, 3)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.bolt_rounded, color: lime, size: 18),
                      const SizedBox(width: 4),
                      Expanded(child: Text(s.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15))),
                    ],
                  ),
                  Text(s.id, style: const TextStyle(color: muted, fontSize: 11.5)),
                  const SizedBox(height: 5),
                  Wrap(
                    spacing: 5,
                    runSpacing: 5,
                    children: [
                      if (s.testMode) ...[
                        _chip(Icons.science_outlined, 'Test Mode', lime),
                        _chip(Icons.visibility_off_outlined, 'Not a public venue', muted),
                      ],
                      if (s.address.isNotEmpty) _chip(Icons.location_on_outlined, s.address, muted),
                      _chip(
                        Icons.wifi_rounded,
                        stationAvailable(s) ? 'Online & Ready · ${s.readyBanks ?? 0} available' : 'Not ready',
                        stationAvailable(s) ? lime : danger,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _chip(IconData icon, String label, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: color.withValues(alpha: 0.35)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 12, color: color),
            const SizedBox(width: 4),
            Text(label, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: color)),
          ],
        ),
      );

  Widget _section(IconData icon, String title, {Widget? trailing}) => Row(
        children: [
          Icon(icon, color: lime, size: 18),
          const SizedBox(width: 8),
          Expanded(child: Text(title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15))),
          ?trailing,
        ],
      );

  Widget _planCard(RentalPricing p) => _card(
        border: lime.withValues(alpha: 0.55),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Expanded(
                  child: Row(
                    children: [
                      Icon(Icons.bolt_rounded, color: lime, size: 20),
                      SizedBox(width: 8),
                      Text('Standard Rental', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
                    ],
                  ),
                ),
                Container(
                  width: 26,
                  height: 26,
                  decoration: const BoxDecoration(shape: BoxShape.circle, color: lime),
                  child: const Icon(Icons.check_rounded, color: ink, size: 17),
                ),
              ],
            ),
            const SizedBox(height: 4),
            const Text('Perfect for a quick charge or extended use.', style: TextStyle(color: muted, fontSize: 12.5)),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(child: _priceBit(money(p.firstHourCents), 'First hour')),
                _sep(),
                Expanded(child: _priceBit(money(p.additionalHourCents), 'Each extra hour')),
                _sep(),
                Expanded(child: _priceBit(money(p.nonReturnMaxCents), 'Non-return fee')),
              ],
            ),
            const SizedBox(height: 8),
            Text('Return within ${p.nonReturnAfterHours} hours to any Zapnivo station.', style: const TextStyle(color: muted, fontSize: 12)),
            const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: Divider(height: 1, color: hairline)),
            Row(
              children: [
                const Icon(Icons.bolt_rounded, color: lime, size: 18),
                const SizedBox(width: 8),
                const Expanded(child: Text('Power Banks', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15))),
                QuantityStepper(count: count, max: maxCount, busy: sending, onChanged: setCount),
              ],
            ),
          ],
        ),
      );

  Widget _sep() => Container(width: 1, height: 30, color: hairline, margin: const EdgeInsets.symmetric(horizontal: 8));

  Widget _priceBit(String value, String label) => Column(
        children: [
          Text(value, style: const TextStyle(fontWeight: FontWeight.w900, fontSize: 15)),
          const SizedBox(height: 2),
          Text(label, textAlign: TextAlign.center, style: const TextStyle(color: muted, fontSize: 10.5)),
        ],
      );

  Widget _details() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _section(Icons.person_outline_rounded, 'Your Details'),
          const SizedBox(height: 8),
          TextFormField(
            controller: email,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            decoration: InputDecoration(
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              labelText: 'Email for your receipt',
              prefixIcon: const Icon(Icons.mail_outline_rounded),
              suffixIcon: AnimatedSwitcher(
                duration: const Duration(milliseconds: 200),
                child: emailOk ? const Icon(Icons.check_circle_rounded, key: ValueKey('ok'), color: lime, size: 20) : const SizedBox(key: ValueKey('none')),
              ),
            ),
            validator: (v) => v != null && RegExp(_emailRe).hasMatch(v.trim()) ? null : 'Enter a valid email address',
          ),
        ],
      );

  Widget _promo() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 300),
            decoration: BoxDecoration(
              color: elevated,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(
                color: appliedPromo != null ? lime.withValues(alpha: 0.6) : promoError != null ? danger.withValues(alpha: 0.6) : hairline,
              ),
            ),
            child: Row(
              children: [
                const SizedBox(width: 14),
                Icon(Icons.sell_outlined, size: 18, color: appliedPromo != null ? lime : muted),
                const SizedBox(width: 10),
                Expanded(
                  child: TextField(
                    controller: promo,
                    enabled: appliedPromo == null,
                    textCapitalization: TextCapitalization.characters,
                    maxLength: 32,
                    decoration: const InputDecoration(
                      hintText: 'Have a promo code?',
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      counterText: '',
                      filled: false,
                      contentPadding: EdgeInsets.symmetric(vertical: 10),
                    ),
                    onSubmitted: (_) => applyPromo(),
                  ),
                ),
                if (appliedPromo != null) ...[
                  const Icon(Icons.check_circle_rounded, color: lime, size: 18),
                  TextButton(onPressed: clearPromo, child: const Text('Remove')),
                ] else
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: FilledButton.tonal(
                      onPressed: applyingPromo ? null : applyPromo,
                      style: FilledButton.styleFrom(
                        backgroundColor: lime.withValues(alpha: 0.14),
                        foregroundColor: lime,
                        minimumSize: const Size(64, 36),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      child: applyingPromo
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: lime))
                          : const Text('Apply'),
                    ),
                  ),
              ],
            ),
          ),
          if (promoError != null) ErrorText(promoError!),
        ],
      );

  Widget _summary(RentalPricing p) => _card(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _section(Icons.receipt_long_outlined, 'Rental Summary'),
            const SizedBox(height: 8),
            _line('Standard Rental ($count power bank${count > 1 ? 's' : ''})', money(firstHourEstimate)),
            _line('Estimated additional hours', '${money(p.additionalHourCents)}/hr'),
            AnimatedSize(
              duration: const Duration(milliseconds: 300),
              curve: Curves.easeInOut,
              child: appliedPromo?.discountPreviewCents != null && appliedPromo!.discountPreviewCents! > 0
                  ? _line('Promo ${appliedPromo!.code} (est.)', '-${money(appliedPromo!.discountPreviewCents! * count)}', valueColor: lime)
                  : const SizedBox.shrink(),
            ),
            const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Divider(height: 1, color: hairline)),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text('Card hold today', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 280),
                  child: Text(money(hold), key: ValueKey(hold), style: const TextStyle(color: lime, fontWeight: FontWeight.w900, fontSize: 18, fontFeatures: [FontFeature.tabularFigures()])),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              'An authorization, not a charge — you pay only for time used, settled on return. '
              'Keep a charger past ${p.nonReturnAfterHours}h and the ${money(p.nonReturnMaxCents)} non-return fee may apply.',
              style: const TextStyle(color: muted, fontSize: 11.5, height: 1.4),
            ),
          ],
        ),
      );

  Widget _line(String a, String b, {Color? valueColor}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Flexible(child: Text(a, style: const TextStyle(color: muted, fontSize: 13.5))),
            const SizedBox(width: 12),
            Text(b, style: TextStyle(fontWeight: FontWeight.w700, color: valueColor, fontFeatures: const [FontFeature.tabularFigures()])),
          ],
        ),
      );

  Widget _terms() => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4),
        child: Row(
          children: [
            GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: () => setState(() => consent = !consent),
              child: SizedBox(
                width: 44,
                height: 44,
                child: Center(
                  child: Checkbox(
                    value: consent,
                    onChanged: (v) => setState(() => consent = v ?? false),
                    visualDensity: VisualDensity.compact,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                ),
              ),
            ),
            Expanded(
              child: Text.rich(
                TextSpan(
                  children: [
                    const TextSpan(text: 'I agree to the '),
                    TextSpan(text: 'Rental Terms', style: const TextStyle(color: lime, decoration: TextDecoration.underline), recognizer: _termsTap),
                    const TextSpan(text: ' and have read the '),
                    TextSpan(text: 'Privacy Policy', style: const TextStyle(color: lime, decoration: TextDecoration.underline), recognizer: _privacyTap),
                    const TextSpan(text: '.'),
                  ],
                ),
                style: const TextStyle(fontSize: 13),
              ),
            ),
          ],
        ),
      );

  Widget _footer() => Container(
        decoration: BoxDecoration(
          color: surface.withValues(alpha: 0.95),
          border: const Border(top: BorderSide(color: hairline)),
        ),
        padding: const EdgeInsets.fromLTRB(20, 10, 20, 10),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.lock_outline_rounded, size: 13, color: muted),
                  const SizedBox(width: 6),
                  Text('${money(hold)} card hold · pay only for time used', style: const TextStyle(color: muted, fontSize: 12)),
                ],
              ),
              const SizedBox(height: 8),
              PrimaryButton(
                label: sending ? 'Preparing secure payment…' : 'Continue to Payment  →',
                icon: sending ? null : Icons.lock_outline_rounded,
                loading: sending,
                onPressed: ready ? pay : null,
              ),
              const SizedBox(height: 6),
              const Text('Secure payment by Stripe — card, Apple Pay or Google Pay. Zapnivo never sees your card number.', textAlign: TextAlign.center, style: TextStyle(color: muted, fontSize: 10.5, height: 1.3)),
            ],
          ),
        ),
      );
}

/* ─────────────────────── dispensing / payment wait ─────────────────────── */

/// Ordered customer-facing dispense stages — the normalized contract the
/// backend derives from durable command/event rows (dispenseStatusFor in
/// src/lib/kiosk/dispatch.ts). The animation mirrors this order; nothing here
/// invents progress.
const _stageOrder = [
  'connecting', 'verifying', 'preparing', 'releasing',
  'dispensing', 'almost_ready', 'ready',
];
const _stageLabels = {
  'connecting': 'Connecting',
  'verifying': 'Verifying',
  'preparing': 'Preparing',
  'releasing': 'Releasing',
  'dispensing': 'Dispensing',
  'almost_ready': 'Almost Ready',
  'ready': 'Ready to Pick Up',
};

/// Watches the authoritative backend — never a timer — for payment
/// confirmation and hardware-confirmed dispensing. Stage comes from the
/// rental's `dispense` block (device_commands + device_events on the server):
/// 'ready' shows success ONLY on a confirmed bank_released/active state,
/// 'failed' shows an honest error, and 'checking' (timeout / unknown outcome)
/// tells the customer verification is in progress instead of pretending.
/// Stages never regress — a stale event can't pull the UI backwards.
class DispensingScreen extends StatefulWidget {
  const DispensingScreen({super.key, required this.knownReferences, required this.checkoutUrl, required this.stationName, required this.bankCount});
  final Set<String> knownReferences;
  final Uri? checkoutUrl;
  final String stationName;
  final int bankCount;
  @override
  State<DispensingScreen> createState() => _DispensingScreenState();
}

class _DispensingScreenState extends State<DispensingScreen> with WidgetsBindingObserver {
  Timer? timer;
  bool checking = false;
  String stage = 'connecting';
  int maxProgress = 0;
  int? slot;
  bool simulated = false;
  String? seenRef;
  String? failMessage;
  bool uncertain = false;
  Rental? fresh;
  late final DateTime startedAt = DateTime.now();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    timer = Timer.periodic(const Duration(seconds: 3), (_) => check());
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

  int progressOf(String s) => _stageOrder.indexOf(s);

  void _applyStage(DispenseInfo? d) {
    if (d == null) return;
    slot = d.slot ?? slot;
    simulated = simulated || d.simulated;
    if (d.stage == 'failed') {
      stage = 'failed';
      failMessage = d.errorCode != null
          ? 'The station reported a problem (${d.errorCode!.replaceAll('_', ' ')}). Your payment hold is released automatically — support can check rental $seenRef.'
          : 'The station did not confirm your power bank. If a hold was placed it is released automatically — support can check rental $seenRef.';
      uncertain = false;
      return;
    }
    if (d.stage == 'checking') {
      stage = 'checking';
      uncertain = true;
      return;
    }
    final p = progressOf(d.stage);
    // Never regress: ignore events that would pull a later stage backwards.
    if (p >= 0 && p >= maxProgress) {
      maxProgress = p;
      stage = d.stage;
      uncertain = false;
    }
  }

  Future<void> check() async {
    if (checking || !mounted) return;
    checking = true;
    final app = AppScope.of(context);
    final navigator = Navigator.of(context);
    try {
      await app.refreshRentals();
    } catch (_) {/* transient — next poll retries */}
    checking = false;
    if (!mounted) return;
    final found = app.rentals?.where((r) => !widget.knownReferences.contains(r.reference)).firstOrNull;
    if (found == null) return; // payment not yet verified — stay 'connecting'
    seenRef = found.reference;
    fresh = found;

    if (found.state == 'active') {
      timer?.cancel();
      navigator.pushReplacement(MaterialPageRoute<void>(builder: (_) => PaymentSuccessScreen(rental: found)));
      return;
    }
    if (!found.isActive) {
      // Paid rental left in-progress without dispensing — cancelled/failed/etc.
      timer?.cancel();
      setState(() {
        stage = 'failed';
        failMessage = 'The station did not confirm your power bank. If you were charged a hold, it is released automatically — support can check rental $seenRef.';
      });
      return;
    }
    // Backend-derived stage; absent block means the command isn't issued yet.
    final d = found.dispense ??
        const DispenseInfo(stage: 'verifying');
    setState(() => _applyStage(d));
  }

  bool get slow => DateTime.now().difference(startedAt).inSeconds > 90;

  /// Target eject position per stage — animated toward over ~1.4s.
  double get ejectTarget => switch (stage) {
        'releasing' => 0.12,
        'dispensing' => 0.5,
        'almost_ready' => 0.82,
        'ready' => 1.0,
        _ => 0.0,
      };

  int get litIndex => progressOf(stage) >= 2 && slot != null ? (slot! - 1).clamp(0, 7) : (progressOf(stage) >= 2 ? 2 : -1);

  String get statusLine => switch (stage) {
        'connecting' => 'Connecting to your station…',
        'verifying' => 'Rental verified.',
        'preparing' => 'Preparing your power bank…',
        'releasing' => 'Releasing charger from ${slot != null ? 'slot $slot' : 'its slot'}…',
        'dispensing' => 'Your power bank is on its way…',
        'almost_ready' => 'Waiting for dispensing confirmation…',
        'ready' => 'Your charger is ready!',
        'checking' => "We're checking the station's status. Please do not start another rental yet.",
        _ => failMessage ?? 'We could not finish dispensing.',
      };

  @override
  Widget build(BuildContext context) {
    final failed = stage == 'failed';
    final connecting = stage == 'connecting';
    final inFlight = !failed && !uncertain;
    return Scaffold(
      appBar: AppBar(
        title: Text(failed ? 'Something went wrong' : uncertain ? 'Verifying status' : 'Preparing Your Charger'),
        leading: CloseButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst)),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 8),
            Center(
              child: Stack(
                alignment: Alignment.center,
                children: [
                  if (reducedMotion(context))
                    KioskIllustration(
                      size: 165,
                      readySlots: fresh?.bankCount ?? 4,
                      dispense: ejectTarget,
                      litSlot: inFlight ? litIndex : -1,
                      ready: stage == 'ready',
                      dimmed: failed || uncertain,
                    )
                  else
                    TweenAnimationBuilder<double>(
                      tween: Tween<double>(begin: 0, end: ejectTarget),
                      duration: const Duration(milliseconds: 1400),
                      curve: Curves.easeInOut,
                      builder: (_, t, _) => KioskIllustration(
                        size: 165,
                        readySlots: fresh?.bankCount ?? 4,
                        dispense: t,
                        litSlot: inFlight ? litIndex : -1,
                        ready: stage == 'ready',
                        dimmed: failed || uncertain,
                      ),
                    ),
                  if (failed)
                    Glass(radius: 50, padding: const EdgeInsets.all(18), child: const Icon(Icons.error_outline_rounded, color: danger, size: 44)),
                ],
              ),
            ),
            const SizedBox(height: 18),
            if (simulated)
              Center(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  margin: const EdgeInsets.only(bottom: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFF9B5DE5).withValues(alpha: 0.16),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: const Color(0xFF9B5DE5).withValues(alpha: 0.5)),
                  ),
                  child: const Text('SIMULATED KIOSK — TEST MODE', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: Color(0xFFC9A6FF), letterSpacing: 0.8)),
                ),
              ),
            Text(
              failed ? 'We could not finish dispensing' : uncertain ? 'Checking with your station' : 'Preparing Your Charger',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 25, fontWeight: FontWeight.w900, letterSpacing: -0.5),
            ),
            const SizedBox(height: 10),
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 500),
              child: Text(
                statusLine,
                key: ValueKey('$stage-$uncertain'),
                textAlign: TextAlign.center,
                style: TextStyle(color: uncertain || failed ? danger : muted, height: 1.5),
              ),
            ),
            if (inFlight) ...[
              const SizedBox(height: 22),
              for (var i = 0; i < _stageOrder.length; i++)
                _stageRow(
                  i < maxProgress || stage == 'ready',
                  i == maxProgress && stage != 'ready',
                  _stageLabels[_stageOrder[i]]!,
                ),
            ],
            if (slow && inFlight)
              const Padding(
                padding: EdgeInsets.only(top: 16),
                child: Text('Taking longer than usual. Keep the app open — or contact support if the bank did not come out.', textAlign: TextAlign.center, style: TextStyle(color: danger, height: 1.4)),
              ),
            const SizedBox(height: 26),
            if (connecting) ...[
              PrimaryButton(label: 'I have paid, check status', onPressed: check),
              const SizedBox(height: 10),
              if (widget.checkoutUrl != null) GlassButton(label: 'Reopen payment page', icon: Icons.open_in_new, onPressed: () => launchUrl(widget.checkoutUrl!, mode: LaunchMode.inAppBrowserView)),
              const SizedBox(height: 6),
              Center(
                child: Text(
                  widget.checkoutUrl != null
                      ? 'Complete payment in your browser — once verified, your rental progresses automatically.'
                      : 'Once verified, your rental progresses automatically.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: muted, fontSize: 12.5, height: 1.4),
                ),
              ),
            ] else if (failed || uncertain) ...[
              PrimaryButton(
                label: 'Contact support',
                icon: Icons.support_agent_rounded,
                onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => NewTicketScreen(category: 'Rental problem', rentalRef: seenRef ?? ''))),
              ),
              const SizedBox(height: 10),
              GlassButton(label: 'Check again', icon: Icons.refresh_rounded, onPressed: check),
              const SizedBox(height: 10),
              GlassButton(label: 'View rental status', onPressed: () {
                AppScope.of(context).setTab(2);
                Navigator.of(context).popUntil((r) => r.isFirst);
              }),
            ],
          ],
        ),
      ),
    );
  }

  Widget _stageRow(bool done, bool current, String label) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AnimatedSwitcher(
              duration: const Duration(milliseconds: 400),
              child: Icon(
                done ? Icons.check_circle_rounded : current ? Icons.circle_rounded : Icons.circle_outlined,
                key: ValueKey('$done-$current'),
                size: 17,
                color: done || current ? lime : muted,
              ),
            ),
            const SizedBox(width: 8),
            AnimatedDefaultTextStyle(
              duration: const Duration(milliseconds: 400),
              style: TextStyle(color: done || current ? Colors.white : muted, fontWeight: FontWeight.w600, fontSize: 13.5),
              child: Text(label),
            ),
          ],
        ),
      );
}
