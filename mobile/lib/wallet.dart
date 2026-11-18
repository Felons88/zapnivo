import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_stripe/flutter_stripe.dart' as stripe;
import 'package:url_launcher/url_launcher.dart';

import 'animations.dart';
import 'api.dart';
import 'app_state.dart';
import 'prepaid_card.dart';
import 'theme.dart';
import 'widget_sync.dart';
import 'widgets.dart';

String _expiryLabel(Map<String, dynamic>? card) {
  final m = (card?['exp_month'] as num?)?.toInt();
  final y = (card?['exp_year'] as num?)?.toInt();
  return (m == null || y == null) ? '--/--' : '${m.toString().padLeft(2, '0')}/${(y % 100).toString().padLeft(2, '0')}';
}

Future<void> _openGoogleWallet(BuildContext context) async {
  final result = await AppScope.of(context).api.googleWalletPass();
  final uri = Uri.tryParse(result['url'] as String? ?? '');
  if (uri == null || uri.host != 'pay.google.com' || !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
    throw const ApiException('Google Wallet could not open. Try again.');
  }
}

class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});
  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  Map<String, dynamic>? data;
  Map<String, dynamic>? revealed;
  String? error;
  bool loading = true;
  bool openingPass = false;
  bool revealing = false;
  bool showBack = false;
  bool started = false;
  Timer? hideTimer;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!started) {
      started = true;
      refresh();
    }
  }

  @override
  void dispose() {
    hideTimer?.cancel();
    super.dispose();
  }

  Future<void> refresh() async {
    setState(() { loading = true; error = null; });
    try {
      final result = await AppScope.of(context).api.wallet();
      if (mounted) setState(() => data = result);
      final cents = (result['balance_cents'] as num?)?.toInt();
      syncHomeWidget(balance: cents == null ? '—' : '\$${(cents / 100).toStringAsFixed(2)}');
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  void say(String message) => ScaffoldMessenger.of(context)..hideCurrentSnackBar()..showSnackBar(SnackBar(content: Text(message), duration: const Duration(seconds: 2)));

  Future<void> addToGoogleWallet() async {
    setState(() { openingPass = true; error = null; });
    try {
      await _openGoogleWallet(context);
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => openingPass = false);
    }
  }

  void hideDetails() {
    hideTimer?.cancel();
    setState(() => showBack = false);
    Future<void>.delayed(const Duration(milliseconds: 800), () { if (mounted && !showBack) setState(() => revealed = null); });
  }

  Future<void> toggleDetails() async {
    if (showBack) return hideDetails();
    setState(() { revealing = true; error = null; });
    try {
      final result = await AppScope.of(context).api.walletCard();
      if (!mounted) return;
      HapticFeedback.selectionClick();
      setState(() { revealed = result; showBack = true; });
      hideTimer?.cancel();
      hideTimer = Timer(const Duration(seconds: 30), () { if (mounted && showBack) hideDetails(); });
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => revealing = false);
    }
  }

  Future<void> copy(String label, String value) async {
    await Clipboard.setData(ClipboardData(text: value));
    if (mounted) say('$label copied');
  }

  @override
  Widget build(BuildContext context) {
    final balance = (data?['balance_cents'] as num?)?.toInt();
    final transactions = (data?['transactions'] as List<dynamic>?) ?? const [];
    final canAddFunds = data?['can_add_funds'] == true;
    final canAddPass = data?['can_add_to_google_wallet'] == true;
    final card = data?['card'] as Map<String, dynamic>?;
    final masked = card?['masked'] as String? ?? '•••• •••• •••• ••••';
    final expiry = _expiryLabel(card);
    final fullNumber = revealed?['number'] as String? ?? masked;
    return TitledPage(
      title: 'Wallet',
      onRefresh: refresh,
      children: [
        if (loading && data == null) const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator(color: lime))),
        if (error != null) Padding(padding: const EdgeInsets.only(bottom: 14), child: StateCard(icon: Icons.wifi_off, title: 'Wallet unavailable', body: error!, action: TextButton(onPressed: refresh, child: const Text('Try again')))),
        if (data != null) ...[
          const Text('AVAILABLE BALANCE', style: TextStyle(color: muted, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.7)),
          const SizedBox(height: 6),
          balance == null ? const Text('—', style: TextStyle(fontSize: 46, fontWeight: FontWeight.w900)) : CountUpMoney(cents: balance, style: const TextStyle(fontSize: 46, fontWeight: FontWeight.w900, letterSpacing: -1.5)),
          const SizedBox(height: 2),
          const Text('Zapnivo prepaid card · works at Zapnivo machines only', style: TextStyle(color: muted, fontSize: 13)),
          const SizedBox(height: 20),
          GestureDetector(
            onTap: card == null || revealing ? null : toggleDetails,
            child: FlipCard(
              showBack: showBack,
              front: ZapnivoCardFront(number: masked, expiry: expiry, status: card?['status'] as String? ?? 'active'),
              back: ZapnivoCardBack(number: fullNumber, expiry: expiry, cvc: revealed?['cvc'] as String? ?? '•••'),
            ),
          ),
          AnimatedSize(
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOutCubic,
            child: showBack && revealed != null
              ? Padding(padding: const EdgeInsets.only(top: 14), child: Row(children: [
                  Expanded(child: _CopyChip(icon: Icons.copy_rounded, label: 'Copy number', onTap: () => copy('Card number', (revealed!['number'] as String).replaceAll(' ', '')))),
                  const SizedBox(width: 10),
                  Expanded(child: _CopyChip(icon: Icons.password_rounded, label: 'Copy code', onTap: () => copy('Security code', revealed!['cvc'] as String))),
                ]))
              : const SizedBox(width: double.infinity),
          ),
          const SizedBox(height: 18),
          Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
            _ActionDot(icon: Icons.add_rounded, label: 'Add funds', primary: true, onTap: () async {
              await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => AddFundsScreen(
                enabled: canAddFunds, publishableKey: data?['publishable_key'] as String?, maskedNumber: masked, expiry: expiry,
              )));
              if (mounted) refresh();
            }),
            _ActionDot(icon: Icons.account_balance_wallet_outlined, label: openingPass ? 'Opening…' : 'Add to Wallet', onTap: openingPass ? null : canAddPass ? addToGoogleWallet : () => say('Google Wallet opens after Zapnivo finishes issuer setup.')),
            _ActionDot(icon: showBack ? Icons.visibility_off_outlined : Icons.visibility_outlined, label: revealing ? 'Loading…' : showBack ? 'Hide details' : 'Card details', onTap: card == null || revealing ? null : toggleDetails),
          ]),
          if (!canAddFunds) const Padding(padding: EdgeInsets.only(top: 14), child: Text('Preview the top-up experience now. Real payments open after Zapnivo finalizes its stored-value terms and payment setup.', style: TextStyle(color: muted, fontSize: 12, height: 1.4), textAlign: TextAlign.center)),
          const SizedBox(height: 26),
          Row(children: [
            const Expanded(child: Text('Activity', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
            if (transactions.length > 4) TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => WalletActivityScreen(transactions: transactions))),
              child: const Text('View all'),
            ),
          ]),
          const SizedBox(height: 4),
          if (transactions.isEmpty) const StateCard(icon: Icons.receipt_long_outlined, title: 'No wallet activity yet', body: 'Rental charges and added funds will appear here.'),
          for (final raw in transactions.take(4)) _WalletActivityTile(raw as Map<String, dynamic>),
          if (transactions.length > 4) Padding(padding: const EdgeInsets.only(top: 10), child: OutlinedButton.icon(
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => WalletActivityScreen(transactions: transactions))),
            icon: const Icon(Icons.list_alt_rounded, size: 18), label: Text('View all ${transactions.length} transactions'),
            style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: const BorderSide(color: Colors.white24), minimumSize: const Size.fromHeight(50), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16))),
          )),
          const SizedBox(height: 18),
          SettingsRow(icon: Icons.credit_card_rounded, label: 'Linked cards', subtitle: 'Cards saved for rentals — brand and last four only', divider: false, onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const LinkedCardsScreen()))),
          const SizedBox(height: 12),
          const Text('Rental charges shown here are actual captured charges after refunds. Your full itemized receipts remain in Rental history. Your Zapnivo card is not a bank card and has no cash value.', style: TextStyle(color: muted, fontSize: 12, height: 1.4)),
        ],
      ],
    );
  }
}

class _ActionDot extends StatelessWidget {
  const _ActionDot({required this.icon, required this.label, required this.onTap, this.primary = false});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool primary;
  @override
  Widget build(BuildContext context) => InkResponse(
    onTap: onTap,
    radius: 44,
    child: SizedBox(width: 92, child: Column(mainAxisSize: MainAxisSize.min, children: [
      AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        width: 58, height: 58,
        decoration: BoxDecoration(shape: BoxShape.circle, color: primary ? lime : Colors.white.withValues(alpha: onTap == null ? .04 : .10), border: primary ? null : Border.all(color: Colors.white.withValues(alpha: .14))),
        child: Icon(icon, color: primary ? ink : (onTap == null ? Colors.white30 : Colors.white), size: 26),
      ),
      const SizedBox(height: 8),
      Text(label, textAlign: TextAlign.center, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: onTap == null ? Colors.white38 : Colors.white)),
    ])),
  );
}

class _CopyChip extends StatelessWidget {
  const _CopyChip({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: Colors.white.withValues(alpha: .08),
    borderRadius: BorderRadius.circular(14),
    child: InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Padding(padding: const EdgeInsets.symmetric(vertical: 13), child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [Icon(icon, size: 17, color: lime), const SizedBox(width: 8), Text(label, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13))])),
    ),
  );
}

class WalletActivityScreen extends StatelessWidget {
  const WalletActivityScreen({super.key, required this.transactions});
  final List<dynamic> transactions;
  @override
  Widget build(BuildContext context) => TitledPage(title: 'All activity', children: [
    const Text('Your charging credit and rental charges', style: TextStyle(color: muted)),
    const SizedBox(height: 12),
    for (final raw in transactions) _WalletActivityTile(raw as Map<String, dynamic>),
  ]);
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
  const AddFundsScreen({super.key, required this.enabled, required this.publishableKey, required this.maskedNumber, required this.expiry});
  final bool enabled;
  final String? publishableKey;
  final String maskedNumber;
  final String expiry;
  @override
  State<AddFundsScreen> createState() => _AddFundsScreenState();
}

class _AddFundsScreenState extends State<AddFundsScreen> with TickerProviderStateMixin {
  late final AnimationController _charge = AnimationController(vsync: this, duration: const Duration(milliseconds: 520));
  late final AnimationController _morph = AnimationController(vsync: this, duration: const Duration(milliseconds: 2600));
  int amount = 1000;
  bool busy = false;
  bool cardReady = false;
  bool cardComplete = false;
  bool funded = false;
  bool morphed = false;
  bool previewing = false;
  bool openingPass = false;
  int? fundedBalance;
  stripe.CardFieldInputDetails? details;
  String? error;

  @override
  void initState() {
    super.initState();
    if (widget.enabled && widget.publishableKey != null) {
      stripe.Stripe.publishableKey = widget.publishableKey!;
      stripe.Stripe.instance.applySettings().then((_) {
        if (mounted) setState(() => cardReady = true);
      }).catchError((Object _) {
        if (mounted) setState(() => error = 'Secure card entry is unavailable right now.');
      });
    }
  }

  @override
  void dispose() {
    _charge.dispose();
    _morph.dispose();
    super.dispose();
  }

  bool _valid(stripe.CardValidationState? s) => s == stripe.CardValidationState.Valid;

  void _onCard(stripe.CardFieldInputDetails? d) {
    if (!mounted) return;
    final stage = d == null ? 0 : (_valid(d.validNumber) ? 1 : 0) + (_valid(d.validExpiryDate) ? 1 : 0) + (_valid(d.validCVC) ? 1 : 0);
    final branded = d?.brand != null && d?.brand != 'Unknown';
    final target = d == null ? 0.0 : d.complete ? 1.0 : (stage / 3) * .9 + (branded ? .06 : 0);
    _charge.animateTo(target.clamp(0.0, 1.0), duration: const Duration(milliseconds: 420), curve: Curves.easeOutCubic);
    setState(() { details = d; cardComplete = d?.complete == true; });
  }

  void _playMorph() {
    if (reducedMotion(context)) {
      _morph.value = 1;
      return;
    }
    HapticFeedback.mediumImpact();
    _morph.forward(from: 0);
    Future<void>.delayed(const Duration(milliseconds: 1850), HapticFeedback.lightImpact);
  }

  void _preview() {
    _morph.reset();
    setState(() { morphed = true; previewing = true; });
    _playMorph();
  }

  Future<void> start() async {
    setState(() { busy = true; error = null; });
    try {
      final api = AppScope.of(context).api;
      final result = await api.startWalletTopup(amount);
      final secret = result['payment_intent_client_secret'] as String?;
      final topupId = result['topup_id'] as String?;
      if (secret == null || topupId == null) throw const ApiException('Payment could not start. Nothing was charged.');
      await stripe.Stripe.instance.confirmPayment(
        paymentIntentClientSecret: secret,
        data: const stripe.PaymentMethodParams.card(paymentMethodData: stripe.PaymentMethodData()),
      );
      for (var attempt = 0; attempt < 12; attempt++) {
        if (!mounted) return;
        await Future<void>.delayed(const Duration(seconds: 1));
        final wallet = await api.wallet();
        final activity = wallet['transactions'] as List<dynamic>? ?? const [];
        if (activity.any((entry) => (entry as Map<String, dynamic>)['id'] == 'topup-$topupId')) {
          if (mounted) {
            setState(() { funded = true; morphed = true; fundedBalance = (wallet['balance_cents'] as num?)?.toInt(); });
            _playMorph();
          }
          return;
        }
      }
      if (mounted) setState(() => error = 'Payment is processing. Your credit appears after confirmation; check Activity shortly.');
    } on stripe.StripeException catch (e) {
      if (mounted) setState(() => error = e.error.localizedMessage ?? 'Card payment did not complete. No credit was added.');
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> addToWallet() async {
    setState(() { openingPass = true; error = null; });
    try {
      await _openGoogleWallet(context);
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => openingPass = false);
    }
  }

  Widget _stage() => AnimatedBuilder(
    animation: Listenable.merge([_charge, _morph]),
    builder: (_, _) => CardMorph(
      t: morphed ? _morph.value : 0,
      source: LiveSourceCard(
        progress: morphed ? 1 : _charge.value,
        brand: details?.brand, last4: details?.last4, expMonth: details?.expiryMonth, expYear: details?.expiryYear,
        numberOk: _valid(details?.validNumber), expiryOk: _valid(details?.validExpiryDate), cvcOk: _valid(details?.validCVC),
      ),
      target: ZapnivoCardFront(number: widget.maskedNumber, expiry: widget.expiry),
    ),
  );

  Widget _reveal({required Widget child}) => FadeTransition(
    opacity: CurvedAnimation(parent: _morph, curve: const Interval(.82, 1, curve: Curves.easeOut)),
    child: SlideTransition(position: Tween(begin: const Offset(0, .12), end: Offset.zero).animate(CurvedAnimation(parent: _morph, curve: const Interval(.82, 1, curve: Curves.easeOutCubic))), child: child),
  );

  @override
  Widget build(BuildContext context) => TitledPage(title: 'Add funds', children: [
    const Text('Power for wherever you go.', style: TextStyle(fontSize: 27, fontWeight: FontWeight.w900, letterSpacing: -0.8)),
    const SizedBox(height: 7),
    Text(funded || previewing ? 'Your card becomes a Zapnivo prepaid card.' : 'Enter your card. It loads your Zapnivo prepaid card — usable only at Zapnivo machines.', style: const TextStyle(color: muted, fontSize: 14, height: 1.5)),
    const SizedBox(height: 22),
    _stage(),
    const SizedBox(height: 22),
    if (funded) _reveal(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('Credit is ready', style: TextStyle(color: lime, fontWeight: FontWeight.w900, fontSize: 24)),
      const SizedBox(height: 6),
      if (fundedBalance != null) Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        CountUpMoney(cents: fundedBalance!, style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w900)),
        const SizedBox(width: 8),
        const Padding(padding: EdgeInsets.only(bottom: 6), child: Text('available now', style: TextStyle(color: muted))),
      ]),
      const SizedBox(height: 6),
      Text('Your Zapnivo card ${widget.maskedNumber.substring(widget.maskedNumber.length - 4)} is loaded. Keep it in your phone wallet for quick access.', style: const TextStyle(color: muted, height: 1.4)),
      const SizedBox(height: 20),
      PrimaryButton(label: 'Add to Google Wallet', icon: Icons.account_balance_wallet_outlined, loading: openingPass, onPressed: addToWallet),
      if (error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(error!, style: const TextStyle(color: danger))),
      const SizedBox(height: 6),
      Center(child: TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Done'))),
    ]))
    else if (previewing) _reveal(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('Preview only', style: TextStyle(color: lime, fontWeight: FontWeight.w900, fontSize: 22)),
      const SizedBox(height: 6),
      const Text('This is how your card turns into a Zapnivo prepaid card. No payment was taken and nothing was added to your balance.', style: TextStyle(color: muted, height: 1.4)),
      const SizedBox(height: 16),
      PrimaryButton(label: 'Replay', icon: Icons.replay_rounded, onPressed: _preview),
    ]))
    else ...[
      const Text('CHOOSE AN AMOUNT', style: TextStyle(color: muted, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.7)),
      const SizedBox(height: 10),
      Wrap(spacing: 10, runSpacing: 10, children: [for (final value in [500, 1000, 2000, 5000]) ChoiceChip(label: Text(money(value)), selected: amount == value, onSelected: (_) => setState(() => amount = value), selectedColor: lime, labelStyle: TextStyle(color: amount == value ? ink : Colors.white, fontWeight: FontWeight.w800), backgroundColor: Colors.white10, side: BorderSide.none)]),
      const SizedBox(height: 22),
      if (widget.enabled && cardReady) ...[
        const Text('YOUR CARD', style: TextStyle(color: muted, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.7)),
        const SizedBox(height: 10),
        Glass(radius: 18, padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), child: stripe.CardField(
          enablePostalCode: false,
          style: const TextStyle(color: Colors.white, fontSize: 16),
          onCardChanged: _onCard,
        )),
        const SizedBox(height: 10),
        const Text('Card entry is handled by our payment provider. Zapnivo receives only the result, card brand and last four digits.', style: TextStyle(color: muted, fontSize: 11, height: 1.4)),
      ] else if (!widget.enabled) const StateCard(icon: Icons.lock_outline_rounded, title: 'Top-ups are being prepared', body: 'Funding opens after the stored-value terms, refund handling and payment setup are approved. You can preview the experience now.'),
      if (error != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(error!, style: const TextStyle(color: danger))),
      const SizedBox(height: 18),
      if (widget.enabled) PrimaryButton(label: 'Add ${money(amount)}', loading: busy, onPressed: cardReady && cardComplete && !busy ? start : null)
      else PrimaryButton(label: 'Preview the card animation', icon: Icons.play_arrow_rounded, onPressed: _preview),
    ],
  ]);
}
