import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'app_state.dart';
import 'theme.dart';
import 'widgets.dart';

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});
  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  Map<String, dynamic>? data;
  String? error;
  bool loading = true;
  bool openingPass = false;
  bool started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!started) {
      started = true;
      refresh();
    }
  }

  Future<void> refresh() async {
    setState(() { loading = true; error = null; });
    try {
      final result = await AppScope.of(context).api.wallet();
      if (mounted) setState(() => data = result);
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> addToGoogleWallet() async {
    setState(() { openingPass = true; error = null; });
    try {
      final result = await AppScope.of(context).api.googleWalletPass();
      final uri = Uri.tryParse(result['url'] as String? ?? '');
      if (uri == null || uri.host != 'pay.google.com' || !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw const ApiException('Google Wallet could not open. Try again.');
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => openingPass = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final balance = (data?['balance_cents'] as num?)?.toInt();
    final transactions = (data?['transactions'] as List<dynamic>?) ?? const [];
    final canAddFunds = data?['can_add_funds'] == true;
    final canAddPass = data?['can_add_to_google_wallet'] == true;
    return TitledPage(
      title: 'Wallet',
      onRefresh: refresh,
      children: [
        if (loading && data == null) const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator(color: lime))),
        if (error != null) Padding(padding: const EdgeInsets.only(bottom: 14), child: StateCard(icon: Icons.wifi_off, title: 'Wallet unavailable', body: error!, action: TextButton(onPressed: refresh, child: const Text('Try again')))),
        if (data != null) ...[
          Glass(
            radius: 28,
            padding: const EdgeInsets.all(24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Eyebrow('ZAPNIVO CHARGING CREDIT'),
              const SizedBox(height: 10),
              Text(balance == null ? '—' : money(balance), style: const TextStyle(fontSize: 42, fontWeight: FontWeight.w900, letterSpacing: -1.5)),
              const SizedBox(height: 5),
              const Text('Available toward charger rentals', style: TextStyle(color: muted, fontSize: 13)),
              const SizedBox(height: 20),
              PrimaryButton(label: 'Add funds', icon: Icons.add_rounded, onPressed: canAddFunds ? () async {
                await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AddFundsScreen()));
                if (mounted) refresh();
              } : null),
              if (!canAddFunds) const Padding(padding: EdgeInsets.only(top: 10), child: Text('Fund loading opens after Zapnivo finalizes its stored-value terms and payment setup.', style: TextStyle(color: muted, fontSize: 12, height: 1.4))),
            ]),
          ),
          const SizedBox(height: 14),
          SettingsRow(icon: Icons.credit_card_rounded, label: 'Linked cards', subtitle: 'View saved cards by brand and last four digits', onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LinkedCardsScreen()))),
          SettingsRow(icon: Icons.account_balance_wallet_outlined, label: 'Add to Google Wallet', subtitle: canAddPass ? 'Save your Zapnivo gift card pass' : 'Available after Google Wallet issuer setup', divider: false, onTap: canAddPass && !openingPass ? addToGoogleWallet : null),
          const SizedBox(height: 10),
          const Text('Activity', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          if (transactions.isEmpty) const StateCard(icon: Icons.receipt_long_outlined, title: 'No wallet activity yet', body: 'Rental charges and added funds will appear here.'),
          for (final raw in transactions) _WalletActivityTile(raw as Map<String, dynamic>),
          const SizedBox(height: 12),
          const Text('Rental charges shown here are actual captured charges after refunds. Your full itemized receipts remain in Rental history.', style: TextStyle(color: muted, fontSize: 12, height: 1.4)),
        ],
      ],
    );
  }
}

class _WalletActivityTile extends StatelessWidget {
  const _WalletActivityTile(this.entry);
  final Map<String, dynamic> entry;
  @override
  Widget build(BuildContext context) {
    final cents = (entry['amount_cents'] as num?)?.toInt() ?? 0;
    final title = entry['title'] as String? ?? 'Transaction';
    final subtitle = entry['subtitle'] as String? ?? '';
    final date = DateTime.tryParse(entry['created_at'] as String? ?? '');
    return Padding(padding: const EdgeInsets.only(top: 9), child: Glass(radius: 18, padding: const EdgeInsets.all(15), child: Row(children: [
      CircleAvatar(backgroundColor: cents < 0 ? danger.withValues(alpha: .13) : lime.withValues(alpha: .16), child: Icon(cents < 0 ? Icons.battery_charging_full_rounded : Icons.add_card_rounded, color: cents < 0 ? danger : lime)),
      const SizedBox(width: 12),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)), Text([subtitle, if (date != null) formatDate(date.toLocal())].where((s) => s.isNotEmpty).join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 11))])),
      const SizedBox(width: 8),
      Text('${cents < 0 ? '-' : '+'}${money(cents.abs())}', style: TextStyle(color: cents < 0 ? danger : lime, fontWeight: FontWeight.w900, fontSize: 15)),
    ])));
  }
}

class LinkedCardsScreen extends StatefulWidget {
  const LinkedCardsScreen({super.key});
  @override
  State<LinkedCardsScreen> createState() => _LinkedCardsScreenState();
}

class _LinkedCardsScreenState extends State<LinkedCardsScreen> {
  List<dynamic>? cards;
  String? error;
  bool started = false;
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!started) { started = true; refresh(); }
  }
  Future<void> refresh() async {
    try {
      final result = await AppScope.of(context).api.linkedCards();
      if (mounted) setState(() { cards = result['cards'] as List<dynamic>? ?? []; error = null; });
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    }
  }
  @override
  Widget build(BuildContext context) => TitledPage(title: 'Linked cards', onRefresh: refresh, children: [
    const Text('Cards saved through secure Stripe checkout. Only the brand, expiry and last four digits are shown here.', style: TextStyle(color: muted, fontSize: 13, height: 1.4)),
    const SizedBox(height: 16),
    if (cards == null && error == null) const Center(child: Padding(padding: EdgeInsets.all(28), child: CircularProgressIndicator(color: lime))),
    if (error != null) StateCard(icon: Icons.wifi_off, title: 'Cards unavailable', body: error!, action: TextButton(onPressed: refresh, child: const Text('Try again'))),
    if (cards?.isEmpty == true) const StateCard(icon: Icons.credit_card_outlined, title: 'No linked cards', body: 'Cards saved during rental checkout will appear here. Card numbers stay with Stripe.'),
    for (final raw in cards ?? const []) Padding(padding: const EdgeInsets.only(bottom: 14), child: _PaymentCard(raw as Map<String, dynamic>)),
  ]);
}

class _PaymentCard extends StatelessWidget {
  const _PaymentCard(this.card);
  final Map<String, dynamic> card;
  @override
  Widget build(BuildContext context) {
    final brand = (card['brand'] as String? ?? 'card').replaceAll('_', ' ');
    final last4 = card['last4'] as String? ?? '••••';
    final month = (card['exp_month'] as num?)?.toInt() ?? 0;
    final year = (card['exp_year'] as num?)?.toInt() ?? 0;
    final funding = card['funding'] as String?;
    return Container(
      constraints: const BoxConstraints(minHeight: 175),
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(24), gradient: const LinearGradient(colors: [Color(0xFF303A50), Color(0xFF171B2B)], begin: Alignment.topLeft, end: Alignment.bottomRight), border: Border.all(color: Colors.white24)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [const Text('ZAPNIVO', style: TextStyle(color: lime, fontWeight: FontWeight.w900, letterSpacing: 2)), const Spacer(), Text(brand.toUpperCase(), style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 16))]),
        const Spacer(),
        Text('••••  ••••  ••••  $last4', style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: 1.5)),
        const SizedBox(height: 15),
        Row(children: [Text(funding == null ? 'Saved card' : '${funding[0].toUpperCase()}${funding.substring(1)} card', style: const TextStyle(color: Colors.white70, fontSize: 12)), const Spacer(), if (month > 0 && year > 0) Text('EXP ${month.toString().padLeft(2, '0')}/$year', style: const TextStyle(color: Colors.white70, fontSize: 12))]),
      ]),
    );
  }
}

class AddFundsScreen extends StatefulWidget {
  const AddFundsScreen({super.key});
  @override
  State<AddFundsScreen> createState() => _AddFundsScreenState();
}

class _AddFundsScreenState extends State<AddFundsScreen> {
  int amount = 1000;
  bool busy = false;
  String? error;
  Future<void> start() async {
    setState(() { busy = true; error = null; });
    try {
      final result = await AppScope.of(context).api.startWalletTopup(amount);
      final uri = Uri.tryParse(result['checkout_url'] as String? ?? '');
      if (uri == null || uri.scheme != 'https' || !uri.host.endsWith('stripe.com') || !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw const ApiException('Secure checkout could not open. Nothing was charged.');
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
  @override
  Widget build(BuildContext context) => TitledPage(title: 'Add funds', children: [
    const Text('Choose an amount of charging credit. Your balance updates only after Stripe confirms payment.', style: TextStyle(color: muted, fontSize: 14, height: 1.5)),
    const SizedBox(height: 18),
    Wrap(spacing: 10, runSpacing: 10, children: [for (final value in [500, 1000, 2000, 5000]) ChoiceChip(label: Text(money(value)), selected: amount == value, onSelected: (_) => setState(() => amount = value), selectedColor: lime, labelStyle: TextStyle(color: amount == value ? ink : Colors.white, fontWeight: FontWeight.w800), backgroundColor: Colors.white10, side: BorderSide.none)]),
    const SizedBox(height: 22),
    if (error != null) Text(error!, style: const TextStyle(color: danger)),
    PrimaryButton(label: 'Continue to secure checkout', loading: busy, onPressed: busy ? null : start),
  ]);
}
