import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'animations.dart' show reducedMotion;
import 'theme.dart';

/// A visual metaphor for confirmed Zapnivo credit. This never changes balance.
class WalletFundingAnimation extends StatefulWidget {
  const WalletFundingAnimation({
    super.key,
    required this.amountCents,
    required this.preview,
  });
  final int amountCents;
  final bool preview;

  @override
  State<WalletFundingAnimation> createState() => _WalletFundingAnimationState();
}

class _WalletFundingAnimationState extends State<WalletFundingAnimation>
    with SingleTickerProviderStateMixin {
  late final AnimationController controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 3600),
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (reducedMotion(context)) {
      controller.value = 1;
    } else if (!controller.isAnimating && controller.value == 0) {
      controller.forward();
    }
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: widget.preview
        ? 'Preview: money falls into the Zapnivo card chip; the card fills and becomes a power bank. No credit was added.'
        : 'Credit confirmed: money falls into the Zapnivo card chip; the card fills and becomes a power bank.',
    child: SizedBox(
      height: 310,
      width: double.infinity,
      child: AnimatedBuilder(
        animation: controller,
        builder: (_, _) => CustomPaint(
          painter: _FundingPainter(controller.value, widget.amountCents),
        ),
      ),
    ),
  );
}

class _FundingPainter extends CustomPainter {
  const _FundingPainter(this.t, this.amountCents);
  final double t;
  final int amountCents;

  double phase(double start, double end) =>
      ((t - start) / (end - start)).clamp(0.0, 1.0);

  void label(
    Canvas canvas,
    String value,
    Offset at,
    double size,
    Color color, {
    FontWeight weight = FontWeight.w800,
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: value,
        style: TextStyle(
          color: color,
          fontSize: size,
          fontWeight: weight,
          letterSpacing: .7,
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    painter.paint(canvas, at);
  }

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height * .58);
    final cardWidth = math.min(size.width * .84, 330.0);
    final cardHeight = cardWidth / 1.586;
    final card = Rect.fromCenter(
      center: center,
      width: cardWidth,
      height: cardHeight,
    );
    final fill = Curves.easeInOutCubic.transform(phase(.16, .76));
    final bank = Curves.easeInOutCubic.transform(phase(.77, 1));
    final chip = Offset(
      card.left + cardWidth * .22,
      card.top + cardHeight * .47,
    );

    // Ground glow makes the increasing charge visible before the final bank reveal.
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(center.dx, card.bottom + 18),
        width: cardWidth * .8,
        height: 24,
      ),
      Paint()
        ..color = lime.withValues(alpha: .08 + fill * .16)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 16),
    );

    canvas.saveLayer(
      card.inflate(30),
      Paint()..color = Colors.white.withValues(alpha: 1 - bank),
    );
    canvas.save();
    canvas.translate(center.dx, center.dy);
    canvas.scale(1 - bank * .38, 1 - bank * .08);
    canvas.translate(-center.dx, -center.dy);
    final shell = RRect.fromRectAndRadius(card, const Radius.circular(24));
    canvas.drawRRect(
      shell,
      Paint()
        ..shader = const LinearGradient(
          colors: [Color(0xFF24493A), Color(0xFF0C1823)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ).createShader(card),
    );
    canvas.save();
    canvas.clipRRect(shell);
    final filled = Rect.fromLTRB(
      card.left,
      card.bottom - cardHeight * fill,
      card.right,
      card.bottom,
    );
    canvas.drawRect(
      filled,
      Paint()
        ..shader = const LinearGradient(
          colors: [Color(0xFFB9F449), Color(0xFF5AAB55)],
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
        ).createShader(card),
    );
    for (var i = 0; i < 4; i++) {
      canvas.drawCircle(
        Offset(card.right, card.bottom),
        cardHeight * (.5 + i * .38),
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1
          ..color = Colors.white.withValues(alpha: .06),
      );
    }
    canvas.restore();
    canvas.drawRRect(
      shell,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.4
        ..color = lime.withValues(alpha: .38 + fill * .5),
    );
    label(
      canvas,
      'ZAPNIVO',
      Offset(card.left + 23, card.top + 19),
      17,
      fill > .83 ? ink : lime,
    );
    label(
      canvas,
      'PREPAID',
      Offset(card.right - 91, card.top + 22),
      10,
      fill > .83 ? ink : Colors.white70,
    );
    final chipRect = RRect.fromRectAndRadius(
      Rect.fromCenter(center: chip, width: 48, height: 35),
      const Radius.circular(6),
    );
    canvas.drawRRect(
      chipRect,
      Paint()
        ..shader = const LinearGradient(
          colors: [Color(0xFFF5E7B1), Color(0xFFB9984D)],
        ).createShader(chipRect.outerRect),
    );
    canvas.drawRRect(
      chipRect,
      Paint()
        ..style = PaintingStyle.stroke
        ..color = const Color(0xFF8A743D)
        ..strokeWidth = 1,
    );
    canvas.drawLine(
      Offset(chip.dx - 15, chip.dy),
      Offset(chip.dx + 15, chip.dy),
      Paint()
        ..color = const Color(0xFF8A743D)
        ..strokeWidth = 1,
    );
    label(
      canvas,
      'ZAPNIVO MACHINES ONLY',
      Offset(card.left + 23, card.bottom - 32),
      9,
      fill > .83 ? ink : Colors.white70,
    );
    canvas.restore();
    canvas.restore();

    // Staggered dollar coins land on the actual chip position, then disappear into it.
    if (bank < .8) {
      for (var i = 0; i < 8; i++) {
        final p = phase(.02 + i * .073, .35 + i * .073);
        if (p <= 0 || p >= 1) continue;
        final x = chip.dx + math.sin(i * 2.4) * (48 * (1 - p));
        final y =
            card.top -
            72 +
            (chip.dy - card.top + 72) * Curves.easeInCubic.transform(p);
        final radius = 13.0 - p * 3;
        final coin = Offset(x, y);
        canvas.drawCircle(
          coin,
          radius + 4,
          Paint()
            ..color = lime.withValues(alpha: .15 * (1 - p))
            ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 9),
        );
        canvas.drawCircle(
          coin,
          radius,
          Paint()..color = const Color(0xFFF6DF8B).withValues(alpha: 1 - bank),
        );
        canvas.drawCircle(
          coin,
          radius - 3,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.2
            ..color = const Color(0xFF8B7130).withValues(alpha: 1 - bank),
        );
        label(
          canvas,
          r'$',
          Offset(x - 4.5, y - 10),
          16,
          const Color(0xFF7C6024).withValues(alpha: 1 - bank),
        );
      }
    }

    if (bank > 0) {
      final bankWidth = cardWidth * .41;
      final bankHeight = cardHeight * 1.08;
      final body = RRect.fromRectAndRadius(
        Rect.fromCenter(center: center, width: bankWidth, height: bankHeight),
        const Radius.circular(23),
      );
      canvas.saveLayer(
        body.outerRect.inflate(18),
        Paint()..color = Colors.white.withValues(alpha: bank),
      );
      canvas.drawRRect(
        body,
        Paint()
          ..shader = const LinearGradient(
            colors: [Color(0xFF2F5949), Color(0xFF112B31), Color(0xFF0B1724)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
          ).createShader(body.outerRect),
      );
      canvas.drawRRect(
        body,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..color = lime.withValues(alpha: .8),
      );
      final port = RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: Offset(center.dx, center.dy - bankHeight / 2 + 6),
          width: 42,
          height: 9,
        ),
        const Radius.circular(4),
      );
      canvas.drawRRect(port, Paint()..color = ink);
      label(canvas, 'Z', Offset(center.dx - 20, center.dy - 37), 58, lime);
      for (var i = 0; i < 4; i++) {
        final bar = RRect.fromRectAndRadius(
          Rect.fromLTWH(center.dx - 30 + i * 16, center.dy + 43, 11, 25),
          const Radius.circular(3),
        );
        canvas.drawRRect(
          bar,
          Paint()
            ..color = i < ((amountCents / 5000).ceil().clamp(1, 4))
                ? lime
                : Colors.white24,
        );
      }
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_FundingPainter old) =>
      old.t != t || old.amountCents != amountCents;
}
