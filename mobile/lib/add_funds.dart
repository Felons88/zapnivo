import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_stripe/flutter_stripe.dart' as stripe;

import 'api.dart';
import 'app_state.dart';
import 'prepaid_card.dart';
import 'theme.dart';
import 'wallet_funding_animation.dart';
import 'widgets.dart';

class AddFundsScreen extends StatefulWidget {
  const AddFundsScreen({
    super.key,
    required this.enabled,
    required this.publishableKey,
    required this.maskedNumber,
    required this.expiry,
  });
  final bool enabled;
  final String? publishableKey;
  final String maskedNumber;
  final String expiry;

  @override
  State<AddFundsScreen> createState() => _AddFundsScreenState();
}

class _AddFundsScreenState extends State<AddFundsScreen> {
  static const amounts = [500, 1000, 2000, 5000];
  int amount = 1000;
  int step = 0;
  bool busy = false;
  bool cardReady = false;
  bool cardComplete = false;
  bool funded = false;
  bool previewing = false;
  int? fundedBalance;
  String? cardLabel;
  String? error;

  @override
  void initState() {
    super.initState();
    if (widget.enabled && widget.publishableKey != null) {
      stripe.Stripe.publishableKey = widget.publishableKey!;
      stripe.Stripe.instance
          .applySettings()
          .then((_) {
            if (mounted) setState(() => cardReady = true);
          })
          .catchError((Object _) {
            if (mounted) {
              setState(
                () => error = 'Secure card entry is unavailable right now.',
              );
            }
          });
    }
  }

  void onCard(stripe.CardFieldInputDetails? details) {
    if (!mounted) return;
    final brand = details?.brand;
    final last4 = details?.last4;
    setState(() {
      cardComplete = details?.complete == true;
      cardLabel = brand == null || brand == 'Unknown'
          ? 'Payment card'
          : '${brand.toUpperCase()}${last4 == null ? '' : ' •••• $last4'}';
      if (!cardComplete && step == 2) step = 1;
    });
  }

  Future<void> confirm() async {
    if (!cardComplete || busy || !widget.enabled) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final api = AppScope.of(context).api;
      final result = await api.startWalletTopup(amount);
      final secret = result['payment_intent_client_secret'] as String?;
      final topupId = result['topup_id'] as String?;
      if (secret == null || topupId == null) {
        throw const ApiException(
          'Payment could not start. Nothing was charged.',
        );
      }
      await stripe.Stripe.instance.confirmPayment(
        paymentIntentClientSecret: secret,
        data: const stripe.PaymentMethodParams.card(
          paymentMethodData: stripe.PaymentMethodData(),
        ),
      );
      for (var attempt = 0; attempt < 12; attempt++) {
        if (!mounted) return;
        await Future<void>.delayed(const Duration(seconds: 1));
        final wallet = await api.wallet();
        final activity = wallet['transactions'] as List<dynamic>? ?? const [];
        if (activity.any(
          (entry) => (entry as Map<String, dynamic>)['id'] == 'topup-$topupId',
        )) {
          if (!mounted) return;
          HapticFeedback.mediumImpact();
          setState(() {
            funded = true;
            fundedBalance = (wallet['balance_cents'] as num?)?.toInt();
          });
          return;
        }
      }
      if (mounted) {
        setState(
          () => error = 'Payment is processing. Credit appears here after confirmation. Check Activity shortly.',
        );
      }
    } on stripe.StripeException catch (e) {
      if (mounted) {
        setState(
          () => error =
              e.error.localizedMessage ??
              'Card payment did not complete. No credit was added.',
        );
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget sectionLabel(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: Text(
      text,
      style: const TextStyle(
        color: muted,
        fontSize: 11,
        fontWeight: FontWeight.w800,
        letterSpacing: 1.6,
      ),
    ),
  );

  Widget amountTile(int value) => Expanded(
    child: Material(
      color: value == amount ? lime : Colors.white.withValues(alpha: .08),
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: busy ? null : () => setState(() => amount = value),
        child: Container(
          constraints: const BoxConstraints(minHeight: 58),
          alignment: Alignment.center,
          child: Text(
            money(value),
            style: TextStyle(
              color: value == amount ? ink : Colors.white,
              fontWeight: FontWeight.w900,
              fontSize: 17,
            ),
          ),
        ),
      ),
    ),
  );

  Widget uses() => Glass(
    radius: 20,
    child: const Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'What this credit does',
          style: TextStyle(fontWeight: FontWeight.w900, fontSize: 15),
        ),
        SizedBox(height: 10),
        Row(
          children: [
            Icon(Icons.battery_charging_full_rounded, color: lime, size: 19),
            SizedBox(width: 10),
            Expanded(
              child: Text(
                'Pays for eligible charging time',
                style: TextStyle(fontSize: 13),
              ),
            ),
          ],
        ),
        SizedBox(height: 9),
        Row(
          children: [
            Icon(Icons.storefront_outlined, color: lime, size: 19),
            SizedBox(width: 10),
            Expanded(
              child: Text(
                'For eligible products at Zapnivo machines',
                style: TextStyle(fontSize: 13),
              ),
            ),
          ],
        ),
        SizedBox(height: 12),
        Text(
          'Brand-only prepaid credit. It cannot be withdrawn, transferred, or used as cash.',
          style: TextStyle(color: muted, fontSize: 12, height: 1.4),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => TitledPage(
    title: funded ? 'Card powered up' : 'Add Zapnivo credit',
    children: [
      if (funded || previewing) ...[
        Text(
          previewing ? 'A preview of your next charge.' : 'Power is ready.',
          style: const TextStyle(
            fontSize: 28,
            fontWeight: FontWeight.w900,
            letterSpacing: -.7,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          previewing
              ? 'No payment was taken and no credit was added.'
              : '${money(amount)} in Zapnivo credit was confirmed.',
          style: const TextStyle(color: muted, fontSize: 14),
        ),
        const SizedBox(height: 12),
        WalletFundingAnimation(
          key: ValueKey('${previewing ? 'preview' : 'funded'}-$amount'),
          amountCents: amount,
          preview: previewing,
        ),
        if (funded && fundedBalance != null)
          Glass(
            radius: 18,
            child: Row(
              children: [
                const Icon(Icons.bolt_rounded, color: lime),
                const SizedBox(width: 10),
                const Expanded(
                  child: Text(
                    'Available credit',
                    style: TextStyle(fontWeight: FontWeight.w700),
                  ),
                ),
                Text(
                  money(fundedBalance!),
                  style: const TextStyle(
                    fontWeight: FontWeight.w900,
                    fontSize: 20,
                    color: lime,
                  ),
                ),
              ],
            ),
          ),
        const SizedBox(height: 16),
        PrimaryButton(
          label: funded ? 'Back to wallet' : 'Back to amounts',
          icon: Icons.arrow_forward_rounded,
          onPressed: () {
            if (funded) {
              Navigator.of(context).pop();
            } else {
              setState(() => previewing = false);
            }
          },
        ),
      ] else ...[
        const Text(
          'Charge your next move.',
          style: TextStyle(
            fontSize: 28,
            fontWeight: FontWeight.w900,
            letterSpacing: -.7,
          ),
        ),
        const SizedBox(height: 6),
        const Text(
          'Load your Zapnivo prepaid card for eligible rentals and vending products.',
          style: TextStyle(color: muted, fontSize: 14, height: 1.4),
        ),
        const SizedBox(height: 20),
        ZapnivoCardFront(number: widget.maskedNumber, expiry: widget.expiry),
        const SizedBox(height: 22),
        sectionLabel('01  CHOOSE CREDIT'),
        Row(
          children: [
            amountTile(amounts[0]),
            const SizedBox(width: 8),
            amountTile(amounts[1]),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            amountTile(amounts[2]),
            const SizedBox(width: 8),
            amountTile(amounts[3]),
          ],
        ),
        const SizedBox(height: 16),
        uses(),
        const SizedBox(height: 22),
        if (widget.enabled && step >= 1) ...[
          sectionLabel('02  PAY SECURELY'),
          Glass(
            radius: 18,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: stripe.CardField(
              enablePostalCode: false,
              style: const TextStyle(color: Colors.white, fontSize: 16),
              onCardChanged: onCard,
            ),
          ),
          const SizedBox(height: 9),
          const Text(
            'Card entry is handled by our payment provider. Zapnivo receives the payment result, card brand and last four digits.',
            style: TextStyle(color: muted, fontSize: 11, height: 1.4),
          ),
          const SizedBox(height: 18),
          if (step == 2)
            Glass(
              radius: 18,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '03  REVIEW PURCHASE',
                    style: TextStyle(
                      color: lime,
                      fontSize: 11,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 1.5,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      const Expanded(child: Text('Zapnivo prepaid credit')),
                      Text(
                        money(amount),
                        style: const TextStyle(fontWeight: FontWeight.w900),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'Payment method',
                          style: TextStyle(color: muted),
                        ),
                      ),
                      Text(
                        cardLabel ?? 'Payment card',
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Divider(color: Colors.white24),
                  const Text(
                    'Only usable for eligible Zapnivo services and products. No cash withdrawal or transfer.',
                    style: TextStyle(color: muted, fontSize: 12, height: 1.4),
                  ),
                ],
              ),
            ),
        ],
        if (!widget.enabled)
          const StateCard(
            icon: Icons.lock_outline_rounded,
            title: 'Top-ups are being prepared',
            body: 'Payments open after Zapnivo finalizes its terms and payment setup. Preview the animation without adding credit.',
          ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              error!,
              style: const TextStyle(color: danger, fontSize: 13),
            ),
          ),
        const SizedBox(height: 18),
        if (!widget.enabled)
          PrimaryButton(
            label: 'Preview how it works',
            icon: Icons.play_arrow_rounded,
            onPressed: () => setState(() => previewing = true),
          )
        else if (step == 0)
          PrimaryButton(
            label: 'Continue with ${money(amount)}',
            icon: Icons.arrow_forward_rounded,
            onPressed: cardReady ? () => setState(() => step = 1) : null,
          )
        else if (step == 1)
          PrimaryButton(
            label: 'Review ${money(amount)} purchase',
            icon: Icons.arrow_forward_rounded,
            onPressed: cardComplete ? () => setState(() => step = 2) : null,
          )
        else
          PrimaryButton(
            label: 'Confirm and add ${money(amount)}',
            loading: busy,
            onPressed: cardComplete && !busy ? confirm : null,
          ),
        if (step > 0 && !busy)
          Center(
            child: TextButton(
              onPressed: () => setState(() => step -= 1),
              child: const Text('Go back'),
            ),
          ),
      ],
    ],
  );
}
