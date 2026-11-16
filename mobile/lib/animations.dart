import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'theme.dart';

/// Every route fades and rises slightly; feels like a native sheet without a heavy slide.
class ZapPageTransitions extends PageTransitionsBuilder {
  const ZapPageTransitions();
  @override
  Widget buildTransitions<T>(PageRoute<T> route, BuildContext context, Animation<double> animation, Animation<double> secondary, Widget child) {
    final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic, reverseCurve: Curves.easeInCubic);
    return FadeTransition(
      opacity: curved,
      child: SlideTransition(
        position: Tween(begin: const Offset(0, 0.04), end: Offset.zero).animate(curved),
        child: child,
      ),
    );
  }
}

/// Fades + rises into place after [delay]. Use [stagger] for lists.
class FadeSlideIn extends StatefulWidget {
  const FadeSlideIn({super.key, required this.child, this.delay = Duration.zero, this.offset = 18});
  final Widget child;
  final Duration delay;
  final double offset;
  @override
  State<FadeSlideIn> createState() => _FadeSlideInState();
}

class _FadeSlideInState extends State<FadeSlideIn> with SingleTickerProviderStateMixin {
  late final c = AnimationController(vsync: this, duration: const Duration(milliseconds: 460));
  Timer? timer;

  @override
  void initState() {
    super.initState();
    if (widget.delay == Duration.zero) {
      c.forward();
    } else {
      timer = Timer(widget.delay, () {
        if (mounted) c.forward();
      });
    }
  }

  @override
  void dispose() {
    timer?.cancel();
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // A covered route keeps its last painted frame during the push transition;
    // freezing mid-animation there makes rows look like they bleed into the next page.
    if (ModalRoute.of(context)?.isCurrent == false) return widget.child;
    final curved = CurvedAnimation(parent: c, curve: Curves.easeOutCubic);
    return AnimatedBuilder(
      animation: curved,
      builder: (_, child) => Opacity(
        opacity: curved.value,
        child: Transform.translate(offset: Offset(0, (1 - curved.value) * widget.offset), child: child),
      ),
      child: widget.child,
    );
  }
}

List<Widget> stagger(Iterable<Widget> children, {Duration step = const Duration(milliseconds: 55), Duration start = Duration.zero}) {
  var i = 0;
  return [for (final w in children) FadeSlideIn(delay: start + step * (i++).clamp(0, 12), child: w)];
}

/// Subtle press feedback (scale-down) for any tappable surface.
class Pressable extends StatefulWidget {
  const Pressable({super.key, required this.child, this.enabled = true});
  final Widget child;
  final bool enabled;
  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool down = false;
  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (_) => widget.enabled ? setState(() => down = true) : null,
    onPointerUp: (_) => setState(() => down = false),
    onPointerCancel: (_) => setState(() => down = false),
    child: AnimatedScale(scale: down ? 0.97 : 1, duration: const Duration(milliseconds: 110), curve: Curves.easeOut, child: widget.child),
  );
}

/// Rotating shimmer block for loading states.
class Skeleton extends StatefulWidget {
  const Skeleton({super.key, this.height = 72, this.radius = 20});
  final double height;
  final double radius;
  @override
  State<Skeleton> createState() => _SkeletonState();
}

class _SkeletonState extends State<Skeleton> with SingleTickerProviderStateMixin {
  late final c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1300))..repeat();
  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (ModalRoute.of(context)?.isCurrent == false) {
      return Container(height: widget.height, decoration: BoxDecoration(borderRadius: BorderRadius.circular(widget.radius), color: Colors.white.withValues(alpha: 0.08)));
    }
    return AnimatedBuilder(
      animation: c,
      builder: (_, _) => Container(
        height: widget.height,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(widget.radius),
          gradient: LinearGradient(
            begin: Alignment(-1.5 + c.value * 3, 0),
            end: Alignment(-0.5 + c.value * 3, 0),
            colors: [Colors.white.withValues(alpha: 0.05), Colors.white.withValues(alpha: 0.14), Colors.white.withValues(alpha: 0.05)],
          ),
        ),
      ),
    );
  }
}

class SkeletonList extends StatelessWidget {
  const SkeletonList({super.key, this.count = 3, this.height = 78});
  final int count;
  final double height;
  @override
  Widget build(BuildContext context) => Column(
    children: [for (var i = 0; i < count; i++) Padding(padding: const EdgeInsets.only(bottom: 12), child: Skeleton(height: height))],
  );
}

/// Ring draws, fills lime, then the check mark strokes in. Fires a haptic when it lands.
class AnimatedCheckmark extends StatefulWidget {
  const AnimatedCheckmark({super.key, this.size = 104, this.onDone});
  final double size;
  final VoidCallback? onDone;
  @override
  State<AnimatedCheckmark> createState() => _AnimatedCheckmarkState();
}

class _AnimatedCheckmarkState extends State<AnimatedCheckmark> with SingleTickerProviderStateMixin {
  late final c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500));

  @override
  void initState() {
    super.initState();
    c.forward().whenComplete(() {
      HapticFeedback.mediumImpact();
      widget.onDone?.call();
    });
  }

  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (ModalRoute.of(context)?.isCurrent == false) {
      return SizedBox(width: widget.size * 1.5, height: widget.size * 1.5, child: CustomPaint(painter: _CheckPainter(1)));
    }
    return AnimatedBuilder(
      animation: c,
      builder: (_, _) => SizedBox(
        width: widget.size * 1.5,
        height: widget.size * 1.5,
        child: CustomPaint(painter: _CheckPainter(c.value)),
      ),
    );
  }
}

class _CheckPainter extends CustomPainter {
  _CheckPainter(this.t);
  final double t;

  double seg(double a, double b, [Curve curve = Curves.easeOutCubic]) => curve.transform(((t - a) / (b - a)).clamp(0.0, 1.0));

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final r = size.width / 3;

    final pulse = seg(0.7, 1.0, Curves.easeOut);
    if (pulse > 0 && pulse < 1) {
      canvas.drawCircle(center, r + pulse * r * 0.55, Paint()..color = lime.withValues(alpha: 0.35 * (1 - pulse)));
    }

    final ring = seg(0.0, 0.5, Curves.easeInOutCubic);
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: r),
      -math.pi / 2,
      2 * math.pi * ring,
      false,
      Paint()
        ..color = lime
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5
        ..strokeCap = StrokeCap.round,
    );

    final fill = seg(0.4, 0.75, Curves.elasticOut);
    if (fill > 0) canvas.drawCircle(center, (r - 2.5) * fill.clamp(0.0, 1.08), Paint()..color = lime);

    final draw = seg(0.55, 0.95);
    if (draw > 0) {
      final path = Path()
        ..moveTo(center.dx - r * 0.42, center.dy + r * 0.02)
        ..lineTo(center.dx - r * 0.1, center.dy + r * 0.34)
        ..lineTo(center.dx + r * 0.46, center.dy - r * 0.3);
      final metric = path.computeMetrics().first;
      canvas.drawPath(
        metric.extractPath(0, metric.length * draw),
        Paint()
          ..color = ink
          ..style = PaintingStyle.stroke
          ..strokeWidth = 7
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round,
      );
    }
  }

  @override
  bool shouldRepaint(_CheckPainter old) => old.t != t;
}

/// Counts a money value up from zero.
class CountUpMoney extends StatelessWidget {
  const CountUpMoney({super.key, required this.cents, this.style, this.delay = Duration.zero});
  final int cents;
  final TextStyle? style;
  final Duration delay;
  @override
  Widget build(BuildContext context) {
    if (ModalRoute.of(context)?.isCurrent == false) return Text(money(cents), style: style);
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0, end: cents.toDouble()),
      duration: const Duration(milliseconds: 900),
      curve: Curves.easeOutCubic,
      builder: (_, v, _) => Text(money(v.round()), style: style),
    );
  }
}

/// Pulses softly; used on live status dots and the "waiting" states.
class Pulse extends StatefulWidget {
  const Pulse({super.key, required this.child});
  final Widget child;
  @override
  State<Pulse> createState() => _PulseState();
}

class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {
  late final c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat(reverse: true);
  @override
  void dispose() {
    c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (ModalRoute.of(context)?.isCurrent == false) return widget.child;
    return FadeTransition(opacity: Tween(begin: 0.45, end: 1.0).animate(CurvedAnimation(parent: c, curve: Curves.easeInOut)), child: widget.child);
  }
}
