import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'animations.dart' show reducedMotion;
import 'theme.dart';

/// Standard card proportions (ISO/IEC 7810 ID-1).
const double kCardAspect = 1.586;
const _tabular = [FontFeature.tabularFigures()];

BoxDecoration _cardDecoration({required List<Color> colors, required Color border, double glow = 0}) => BoxDecoration(
  borderRadius: BorderRadius.circular(24),
  gradient: LinearGradient(colors: colors, begin: Alignment.topLeft, end: Alignment.bottomRight),
  border: Border.all(color: border, width: 1.2),
  boxShadow: [
    BoxShadow(color: Colors.black.withValues(alpha: .45), blurRadius: 28, offset: const Offset(0, 16)),
    if (glow > 0) BoxShadow(color: lime.withValues(alpha: .38 * glow), blurRadius: 34 * glow + 6, spreadRadius: 1.5 * glow),
  ],
);

/// The Zapnivo prepaid card, front. Only honored at Zapnivo machines and machines we service.
class ZapnivoCardFront extends StatefulWidget {
  const ZapnivoCardFront({super.key, required this.number, required this.expiry, this.status = 'active'});
  final String number;
  final String expiry;
  final String status;
  @override
  State<ZapnivoCardFront> createState() => _ZapnivoCardFrontState();
}

class _ZapnivoCardFrontState extends State<ZapnivoCardFront> with SingleTickerProviderStateMixin {
  late final AnimationController _shine = AnimationController(vsync: this, duration: const Duration(milliseconds: 3600));
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started && !reducedMotion(context)) {
      _started = true;
      _shine.repeat();
    }
  }

  @override
  void dispose() {
    _shine.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AspectRatio(
    aspectRatio: kCardAspect,
    child: Container(
      decoration: _cardDecoration(colors: const [Color(0xFF24493A), Color(0xFF122231), Color(0xFF0B0D24)], border: lime.withValues(alpha: .38), glow: .25),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: Stack(fit: StackFit.expand, children: [
          const CustomPaint(painter: _CardArtPainter()),
          AnimatedBuilder(
            animation: _shine,
            builder: (_, _) => DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(
              begin: Alignment(-2.2 + 4.4 * _shine.value, -1),
              end: Alignment(-1.2 + 4.4 * _shine.value, 1),
              colors: [Colors.transparent, Colors.white.withValues(alpha: .11), Colors.transparent],
            ))),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 20, 22, 18),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                const Text('ZAPNIVO', style: TextStyle(color: lime, fontWeight: FontWeight.w900, letterSpacing: 3, fontSize: 18)),
                const Spacer(),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(99), border: Border.all(color: lime.withValues(alpha: .55))),
                  child: Text(widget.status == 'frozen' ? 'FROZEN' : 'PREPAID', style: const TextStyle(color: lime, fontSize: 10, fontWeight: FontWeight.w900, letterSpacing: 1.6)),
                ),
              ]),
              const Spacer(),
              const _Chip(),
              const SizedBox(height: 14),
              FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(widget.number, style: const TextStyle(color: Colors.white, fontSize: 23, fontWeight: FontWeight.w700, letterSpacing: 2.2, fontFeatures: _tabular))),
              const SizedBox(height: 12),
              Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text('VALID THRU', style: TextStyle(color: Colors.white54, fontSize: 8.5, fontWeight: FontWeight.w800, letterSpacing: 1.4)),
                  Text(widget.expiry, style: const TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800, fontFeatures: _tabular)),
                ]),
                const Spacer(),
                const Text('ZAPNIVO MACHINES ONLY', style: TextStyle(color: Colors.white54, fontSize: 8.5, fontWeight: FontWeight.w800, letterSpacing: 1.3)),
              ]),
            ]),
          ),
        ]),
      ),
    ),
  );
}

/// Card back: the 3-digit security code. Shown only after an explicit reveal.
class ZapnivoCardBack extends StatelessWidget {
  const ZapnivoCardBack({super.key, required this.number, required this.expiry, required this.cvc});
  final String number;
  final String expiry;
  final String cvc;
  @override
  Widget build(BuildContext context) => AspectRatio(
    aspectRatio: kCardAspect,
    child: Container(
      decoration: _cardDecoration(colors: const [Color(0xFF1A2E27), Color(0xFF0E1A27), Color(0xFF0B0D24)], border: lime.withValues(alpha: .3)),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const SizedBox(height: 22),
          Container(height: 38, color: Colors.black.withValues(alpha: .75)),
          const SizedBox(height: 16),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Row(children: [
              Expanded(child: Container(height: 38, alignment: Alignment.centerLeft, padding: const EdgeInsets.only(left: 12), decoration: BoxDecoration(color: Colors.white.withValues(alpha: .08), borderRadius: BorderRadius.circular(8)), child: const Text('AUTHORIZED ZAPNIVO CARD', style: TextStyle(color: Colors.white38, fontSize: 9, fontWeight: FontWeight.w800, letterSpacing: 1.2)))),
              const SizedBox(width: 10),
              Container(
                width: 70, height: 38, alignment: Alignment.center,
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(8)),
                child: Text(cvc, style: const TextStyle(color: ink, fontWeight: FontWeight.w900, fontSize: 19, letterSpacing: 2, fontFeatures: _tabular)),
              ),
            ]),
          ),
          Padding(padding: const EdgeInsets.only(right: 24, top: 3), child: const Align(alignment: Alignment.centerRight, child: Text('SECURITY CODE', style: TextStyle(color: Colors.white38, fontSize: 8, fontWeight: FontWeight.w800, letterSpacing: 1.2)))),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Row(children: [
              Expanded(child: FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Text(number, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700, letterSpacing: 1.8, fontFeatures: _tabular)))),
              const SizedBox(width: 10),
              Text(expiry, style: const TextStyle(color: Colors.white70, fontSize: 13, fontWeight: FontWeight.w800, fontFeatures: _tabular)),
            ]),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: Text('Valid only at Zapnivo machines and machines we service. Not a bank card. No cash value.', style: TextStyle(color: Colors.white38, fontSize: 8.5, height: 1.35)),
          ),
        ]),
      ),
    ),
  );
}

class _Chip extends StatelessWidget {
  const _Chip();
  @override
  Widget build(BuildContext context) => Container(
    width: 44, height: 33,
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(7),
      gradient: const LinearGradient(colors: [Color(0xFFE8D28A), Color(0xFFB9964A)], begin: Alignment.topLeft, end: Alignment.bottomRight),
    ),
    child: CustomPaint(painter: _ChipLinesPainter()),
  );
}

class _ChipLinesPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Colors.black.withValues(alpha: .22)..strokeWidth = 1..style = PaintingStyle.stroke;
    canvas.drawLine(Offset(0, size.height / 2), Offset(size.width, size.height / 2), p);
    canvas.drawLine(Offset(size.width / 3, 0), Offset(size.width / 3, size.height), p);
    canvas.drawLine(Offset(size.width * 2 / 3, 0), Offset(size.width * 2 / 3, size.height), p);
  }
  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

/// Faint arcs and a bolt — the Zapnivo mark as card art.
class _CardArtPainter extends CustomPainter {
  const _CardArtPainter();
  @override
  void paint(Canvas canvas, Size size) {
    final arc = Paint()..style = PaintingStyle.stroke..strokeWidth = 1.2..color = lime.withValues(alpha: .08);
    for (var i = 1; i <= 4; i++) {
      canvas.drawCircle(Offset(size.width * .92, size.height * 1.05), size.height * .28 * i, arc);
    }
    final bolt = Path()
      ..moveTo(size.width * .74, size.height * .12)
      ..lineTo(size.width * .60, size.height * .52)
      ..lineTo(size.width * .70, size.height * .52)
      ..lineTo(size.width * .64, size.height * .88)
      ..lineTo(size.width * .88, size.height * .42)
      ..lineTo(size.width * .77, size.height * .42)
      ..lineTo(size.width * .84, size.height * .12)
      ..close();
    canvas.drawPath(bolt, Paint()..color = lime.withValues(alpha: .05));
  }
  @override
  bool shouldRepaint(covariant CustomPainter old) => false;
}

/// Flips between two faces around the Y axis.
class FlipCard extends StatelessWidget {
  const FlipCard({super.key, required this.front, required this.back, required this.showBack});
  final Widget front;
  final Widget back;
  final bool showBack;
  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
    tween: Tween(end: showBack ? 1.0 : 0.0),
    duration: reducedMotion(context) ? Duration.zero : const Duration(milliseconds: 720),
    curve: Curves.easeInOutCubic,
    builder: (_, v, _) => Transform(
      alignment: Alignment.center,
      transform: Matrix4.identity()..setEntry(3, 2, .0011)..rotateY(v * math.pi),
      child: v > .5 ? Transform(alignment: Alignment.center, transform: Matrix4.rotationY(math.pi), child: back) : front,
    ),
  );
}

/// The customer's own bank card as it is typed. Number, expiry and code light up as each validates;
/// the card digits themselves never reach the app (the payment provider's field owns them).
class LiveSourceCard extends StatefulWidget {
  const LiveSourceCard({super.key, required this.progress, this.brand, this.last4, this.expMonth, this.expYear, this.numberOk = false, this.expiryOk = false, this.cvcOk = false});
  /// 0..1 — how far along the card entry is. Drives glow, lean and the scan line.
  final double progress;
  final String? brand;
  final String? last4;
  final int? expMonth;
  final int? expYear;
  final bool numberOk;
  final bool expiryOk;
  final bool cvcOk;
  @override
  State<LiveSourceCard> createState() => _LiveSourceCardState();
}

class _LiveSourceCardState extends State<LiveSourceCard> with SingleTickerProviderStateMixin {
  late final AnimationController _scan = AnimationController(vsync: this, duration: const Duration(milliseconds: 2200));
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_started && !reducedMotion(context)) {
      _started = true;
      _scan.repeat();
    }
  }

  @override
  void dispose() {
    _scan.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.progress.clamp(0.0, 1.0);
    final border = Color.lerp(Colors.white24, lime, p)!;
    final exp = (widget.expMonth != null && widget.expYear != null) ? '${widget.expMonth.toString().padLeft(2, '0')}/${(widget.expYear! % 100).toString().padLeft(2, '0')}' : 'MM/YY';
    return Transform(
      alignment: Alignment.center,
      transform: Matrix4.identity()..setEntry(3, 2, .001)..rotateY(-.16 * (1 - p))..rotateX(.05 * (1 - p)),
      child: AspectRatio(
        aspectRatio: kCardAspect,
        child: Container(
          decoration: _cardDecoration(colors: [Color.lerp(const Color(0xFF2B3045), const Color(0xFF244638), p)!, const Color(0xFF14172A)], border: border, glow: p),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(24),
            child: Stack(fit: StackFit.expand, children: [
              if (p < 1)
                AnimatedBuilder(
                  animation: _scan,
                  builder: (_, _) => Align(
                    alignment: Alignment(-1 + 2 * _scan.value, 0),
                    child: Container(width: 2, height: double.infinity, decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, lime.withValues(alpha: .5), Colors.transparent]))),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(22, 20, 22, 18),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    AnimatedSwitcher(duration: const Duration(milliseconds: 260), child: Text((widget.brand == null || widget.brand == 'Unknown') ? 'YOUR CARD' : widget.brand!.toUpperCase().replaceAll('_', ' '), key: ValueKey(widget.brand), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, letterSpacing: 2, fontSize: 15))),
                    const Spacer(),
                    Icon(Icons.contactless_rounded, color: Color.lerp(Colors.white38, lime, p), size: 26),
                  ]),
                  const Spacer(),
                  FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerLeft, child: Row(children: [
                    for (var g = 0; g < 4; g++) ...[
                      if (g > 0) const SizedBox(width: 14),
                      AnimatedSwitcher(
                        duration: const Duration(milliseconds: 240),
                        transitionBuilder: (c, a) => FadeTransition(opacity: a, child: SlideTransition(position: Tween(begin: const Offset(0, .35), end: Offset.zero).animate(a), child: c)),
                        child: Text(g == 3 && widget.last4 != null ? widget.last4! : (g == 3 ? '••••' : (widget.numberOk ? '••••' : '····')), key: ValueKey('$g-${widget.last4}-${widget.numberOk}'), style: TextStyle(color: g == 3 && widget.last4 != null ? Colors.white : Colors.white70, fontSize: 23, fontWeight: FontWeight.w700, letterSpacing: 2, fontFeatures: _tabular)),
                      ),
                    ],
                  ])),
                  const SizedBox(height: 14),
                  Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      const Text('VALID THRU', style: TextStyle(color: Colors.white54, fontSize: 8.5, fontWeight: FontWeight.w800, letterSpacing: 1.4)),
                      Text(exp, style: TextStyle(color: widget.expiryOk ? Colors.white : Colors.white54, fontSize: 15, fontWeight: FontWeight.w800, fontFeatures: _tabular)),
                    ]),
                    const Spacer(),
                    _Led(label: 'NUMBER', on: widget.numberOk),
                    const SizedBox(width: 6),
                    _Led(label: 'EXPIRY', on: widget.expiryOk),
                    const SizedBox(width: 6),
                    _Led(label: 'CVC', on: widget.cvcOk),
                  ]),
                ]),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

class _Led extends StatelessWidget {
  const _Led({required this.label, required this.on});
  final String label;
  final bool on;
  @override
  Widget build(BuildContext context) => AnimatedContainer(
    duration: const Duration(milliseconds: 280),
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: BoxDecoration(color: on ? lime : Colors.white10, borderRadius: BorderRadius.circular(99)),
    child: Text(label, style: TextStyle(color: on ? ink : Colors.white38, fontSize: 8, fontWeight: FontWeight.w900, letterSpacing: .8)),
  );
}

/// Timed card-to-prepaid-card sequence. [t] runs 0..1:
/// 0.00–0.25 the entered card charges up, 0.25–0.70 it flips, 0.70–0.88 it settles with a small overshoot,
/// 0.88–1.00 holds so the balance and wallet actions can arrive.
class CardMorph extends StatelessWidget {
  const CardMorph({super.key, required this.t, required this.source, required this.target});
  final double t;
  final Widget source;
  final Widget target;
  @override
  Widget build(BuildContext context) {
    final charge = Curves.easeOut.transform((t / .25).clamp(0.0, 1.0));
    final flip = Curves.easeInOutCubic.transform(((t - .25) / .45).clamp(0.0, 1.0));
    final settle = Curves.easeOutBack.transform(((t - .70) / .18).clamp(0.0, 1.0));
    final arc = math.sin(flip * math.pi);
    final scale = 1 + .04 * charge * (1 - flip) + .08 * arc + .025 * math.sin(settle * math.pi);
    final lift = -22 * arc;
    final back = flip > .5;
    return Transform(
      alignment: Alignment.center,
      transform: Matrix4.identity()..setEntry(3, 2, .0011)..translateByDouble(0, lift, 0, 1)..scaleByDouble(scale, scale, 1, 1)..rotateY(flip * math.pi),
      child: back ? Transform(alignment: Alignment.center, transform: Matrix4.rotationY(math.pi), child: target) : source,
    );
  }
}
