import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zapnivo_mobile/add_funds.dart';
import 'package:zapnivo_mobile/theme.dart';
import 'package:zapnivo_mobile/wallet_funding_animation.dart';

void main() {
  testWidgets('unavailable top-ups offer a clearly labeled preview', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildTheme(),
        home: const AddFundsScreen(
          enabled: false,
          publishableKey: null,
          maskedNumber: '•••• •••• •••• 1234',
          expiry: '12/28',
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 700));
    await tester.scrollUntilVisible(find.text('Preview how it works'), 250);
    await tester.tap(find.text('Preview how it works'));
    await tester.pump();
    await tester.drag(find.byType(ListView), const Offset(0, 700));
    await tester.pump(const Duration(milliseconds: 700));
    expect(
      find.text('No payment was taken and no credit was added.'),
      findsOneWidget,
    );
    expect(find.byType(WalletFundingAnimation), findsOneWidget);
  });
}
