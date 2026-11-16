import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'animations.dart';
import 'api.dart';
import 'app_state.dart';
import 'support.dart';
import 'theme.dart';
import 'widgets.dart';

String _duration(Duration d) => '${d.inHours}h ${d.inMinutes % 60}m';

/// Itemized order summary built only from fields the server returned.
class ReceiptCard extends StatelessWidget {
  const ReceiptCard({super.key, required this.rental, this.animateRows = false, this.delay = Duration.zero});
  final Rental rental;
  final bool animateRows;
  final Duration delay;

  @override
  Widget build(BuildContext context) {
    final r = rental;
    final duration = r.startedAt != null && r.endedAt != null ? r.endedAt!.difference(r.startedAt!) : null;
    final captured = r.amountCents;
    final rows = <Widget>[
      _row('Station', r.venue + (r.city.isEmpty ? '' : ', ${r.city}')),
      _row('Rental ID', r.reference),
      _row('Power banks', '${r.bankCount}'),
      if (r.startedAt != null) _row('Started', '${formatDate(r.startedAt!)}, ${formatTime(r.startedAt!)}'),
      if (r.endedAt != null) _row('Returned', '${formatDate(r.endedAt!)}, ${formatTime(r.endedAt!)}'),
      if (duration != null) _row('Duration', _duration(duration)),
      if (captured != null) ...[
        const Divider(height: 26, color: Colors.white24),
        _row('Subtotal', money(r.subtotalCents ?? captured)),
        if ((r.discountCents ?? 0) > 0) _row('Discount${r.promoCode != null ? ' (${r.promoCode})' : ''}', '-${money(r.discountCents!)}'),
        if ((r.taxCents ?? 0) > 0) _row('Tax', money(r.taxCents!)),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            const Text('Total charged', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
            CountUpMoney(cents: captured, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w900, color: lime)),
          ],
        ),
      ] else if (r.authorizedCents != null) ...[
        const Divider(height: 26, color: Colors.white24),
        _row('Card hold', money(r.authorizedCents!)),
        const Padding(
          padding: EdgeInsets.only(top: 6),
          child: Text('This is a temporary hold. You are charged the actual rental time after you return the power bank.', style: TextStyle(color: muted, fontSize: 12, height: 1.4)),
        ),
      ],
      if (r.receiptEmail != null) Padding(padding: const EdgeInsets.only(top: 14), child: Text('Receipt emailed to ${r.receiptEmail}', style: const TextStyle(color: muted, fontSize: 12))),
    ];
    return Glass(
      padding: const EdgeInsets.all(22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: animateRows ? stagger(rows, start: delay, step: const Duration(milliseconds: 70)) : rows,
      ),
    );
  }

  Widget _row(String a, String b) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [Text(a, style: const TextStyle(color: muted)), const SizedBox(width: 16), Flexible(child: Text(b, textAlign: TextAlign.right, style: const TextStyle(fontWeight: FontWeight.w700)))],
    ),
  );
}

class _SuccessPage extends StatelessWidget {
  const _SuccessPage({required this.title, required this.message, required this.rental, required this.actions});
  final String title;
  final String message;
  final Rental rental;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: ListView(
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 28),
        children: [
          const Center(child: AnimatedCheckmark()),
          FadeSlideIn(
            delay: const Duration(milliseconds: 1100),
            child: Column(
              children: [
                Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w900, letterSpacing: -0.9)),
                const SizedBox(height: 8),
                Text(message, textAlign: TextAlign.center, style: const TextStyle(color: muted, height: 1.45)),
              ],
            ),
          ),
          const SizedBox(height: 24),
          FadeSlideIn(delay: const Duration(milliseconds: 1300), offset: 36, child: ReceiptCard(rental: rental, animateRows: true, delay: const Duration(milliseconds: 1400))),
          const SizedBox(height: 24),
          FadeSlideIn(delay: const Duration(milliseconds: 1900), child: Column(children: actions)),
        ],
      ),
    ),
  );
}

/// Shown the moment the server confirms payment: ring draws, check strokes in, order summary rises.
class PaymentSuccessScreen extends StatelessWidget {
  const PaymentSuccessScreen({super.key, required this.rental});
  final Rental rental;
  @override
  Widget build(BuildContext context) => _SuccessPage(
    title: 'Payment successful',
    message: rental.state == 'active' ? 'Your rental has started. Take your charger from the station.' : 'Your payment went through. The station is dispensing your power bank now.',
    rental: rental,
    actions: [
      PrimaryButton(
        label: 'Go to Active Rental',
        onPressed: () {
          AppScope.of(context).setTab(2);
          Navigator.of(context).popUntil((r) => r.isFirst);
        },
      ),
      const SizedBox(height: 10),
      GlassButton(label: 'View Receipt', icon: Icons.receipt_long_outlined, onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ReceiptScreen(rental: rental)))),
    ],
  );
}

class ReturnSuccessScreen extends StatelessWidget {
  const ReturnSuccessScreen({super.key, required this.rental});
  final Rental rental;
  @override
  Widget build(BuildContext context) => _SuccessPage(
    title: 'Return successful',
    message: 'Your charger is back. Thanks for using Zapnivo!',
    rental: rental,
    actions: [
      PrimaryButton(label: 'Done', onPressed: () {
        AppScope.of(context).setTab(0);
        Navigator.of(context).popUntil((r) => r.isFirst);
      }),
      const SizedBox(height: 10),
      GlassButton(label: 'View Receipt', icon: Icons.receipt_long_outlined, onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ReceiptScreen(rental: rental)))),
    ],
  );
}

class ReceiptScreen extends StatelessWidget {
  const ReceiptScreen({super.key, required this.rental});
  final Rental rental;
  @override
  Widget build(BuildContext context) => TitledPage(
    title: 'Receipt',
    children: [
      Row(children: [const Logo(size: 28), const Spacer(), _Status(rental)]),
      const SizedBox(height: 14),
      ReceiptCard(rental: rental),
      const SizedBox(height: 14),
      GlassButton(
        label: 'Copy rental ID',
        icon: Icons.copy_rounded,
        onPressed: () {
          Clipboard.setData(ClipboardData(text: rental.reference));
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Rental ID copied')));
        },
      ),
      const SizedBox(height: 10),
      GlassButton(
        label: 'Problem with this rental?',
        icon: Icons.support_agent_rounded,
        onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => NewTicketScreen(category: 'Billing question', rentalRef: rental.reference))),
      ),
    ],
  );
}

class _Status extends StatelessWidget {
  const _Status(this.r);
  final Rental r;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    decoration: BoxDecoration(color: (r.isActive ? lime : Colors.white).withValues(alpha: 0.14), borderRadius: BorderRadius.circular(20)),
    child: Text(r.stateLabel, style: TextStyle(color: r.isActive ? lime : Colors.white70, fontWeight: FontWeight.w800, fontSize: 12)),
  );
}
