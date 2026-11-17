import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:zapnivo_mobile/api.dart';
import 'package:zapnivo_mobile/app_state.dart';
import 'package:zapnivo_mobile/checkout.dart';
import 'package:zapnivo_mobile/stations.dart';
import 'package:zapnivo_mobile/theme.dart';

const station = Station(
  id: 'ZN-TEST1',
  name: 'Test station',
  address: 'Test location',
  city: 'Saint Paul',
  state: 'MN',
  lat: null,
  lng: null,
  readyBanks: 3,
  rentalsAvailable: true,
  testMode: true,
);

const pricing = RentalPricing(
  firstHourCents: 699,
  additionalHourCents: 299,
  nonReturnMaxCents: 4500,
  nonReturnAfterHours: 24,
  holdCentsPerBank: 1200,
);

class FakeApi extends ZapnivoApi {
  RentalQuote? quote;
  Object? quoteError;
  int quoteCalls = 0;
  Uri? checkoutUrl;
  Object? checkoutError;
  int checkoutCalls = 0;
  List<Rental> rentalRows = const [];

  @override
  Future<List<Rental>> rentalList() async => rentalRows;

  @override
  Future<RentalQuote> checkoutQuote({required String stationId, required int bankCount, String? promoCode}) async {
    quoteCalls++;
    if (quoteError != null) throw quoteError!;
    return quote ??
        RentalQuote(
          stationId: stationId,
          bankCount: bankCount,
          readyBanks: 3,
          holdCents: 1200 * bankCount,
          firstHourEstimateCents: 699 * bankCount,
          additionalHourCents: 299,
          nonReturnMaxCents: 4500,
          nonReturnAfterHours: 24,
        );
  }

  @override
  Future<CheckoutInit> createCheckout({required String stationId, required String email, required int bankCount, String? promoCode}) async {
    checkoutCalls++;
    if (checkoutError != null) throw checkoutError!;
    return CheckoutInit.hosted(checkoutUrl ?? Uri.parse('https://checkout.stripe.com/c/pay/test'));
  }
}

Widget wrap(Widget child, {FakeApi? api}) => MaterialApp(
      theme: buildTheme(),
      home: AppScope(state: AppState(api: api ?? FakeApi()), child: child),
    );

void main() {
  // Tall surface so the whole checkout list is laid out (ListView builds lazily).
  void bigSurface(WidgetTester t) {
    t.view.physicalSize = const Size(900, 2600);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
  }

  test('station json carries the test-mode flag', () {
    final s = Station.fromJson({
      'id': 'K1', 'name': 'n', 'address': 'a', 'city': 'c', 'state': 's',
      'ready_banks': 2, 'rentals_available': true, 'test_mode': true,
    });
    expect(s.testMode, isTrue);
    expect(Station.fromJson({'id': 'K2', 'name': 'n', 'address': 'a', 'city': 'c', 'state': 's'}).testMode, isFalse);
  });

  test('station json carries venue fields and honest station_state', () {
    final s = Station.fromJson({
      'id': 'K1', 'name': "McCoy's Pub", 'address': 'a', 'city': 'Elk River', 'state': 'MN',
      'station_state': 'offline', 'venue_type': 'bar', 'phone': '+1 763-555-0100',
      'website': 'https://example.com', 'description': 'd', 'accessibility': 'ramp',
      'slot_count': 8, 'zip': '55330',
    });
    expect(s.stationState, 'offline');
    expect(s.venueType, 'bar');
    expect(s.phone, '+1 763-555-0100');
    expect(s.slotCount, 8);
    // Old payloads without new fields still parse.
    final old = Station.fromJson({'id': 'K2', 'name': 'n', 'address': 'a', 'city': 'c', 'state': 's'});
    expect(old.stationState, isNull);
    expect(old.venueType, isNull);
  });

  test('offline and stale stations are never marked available', () {
    final offline = Station.fromJson({'id': 'K1', 'name': 'n', 'address': 'a', 'city': 'c', 'state': 's', 'station_state': 'offline', 'ready_banks': 5});
    final stale = Station.fromJson({'id': 'K2', 'name': 'n', 'address': 'a', 'city': 'c', 'state': 's', 'station_state': 'stale', 'ready_banks': 5});
    final live = Station.fromJson({'id': 'K3', 'name': 'n', 'address': 'a', 'city': 'c', 'state': 's', 'station_state': 'available', 'ready_banks': 2});
    expect(stationAvailable(offline), isFalse);
    expect(stationAvailable(stale), isFalse);
    expect(stationAvailable(live), isTrue);
    expect(availabilityLabel(offline), 'Station offline');
    expect(availabilityLabel(stale), 'Status unconfirmed');
    expect(availabilityLabel(live), '2 chargers available');
  });

  test('quote json parses server amounts and promo preview', () {
    final q = RentalQuote.fromJson({
      'station_id': 'ZN-1', 'bank_count': 2, 'ready_banks': 3, 'hold_cents': 9000,
      'first_hour_estimate_cents': 1398, 'additional_hour_cents': 699,
      'non_return_max_cents': 4500, 'non_return_after_hours': 24,
      'promo': {'code': 'SAVE10', 'valid': true, 'percent_off': 10, 'discount_preview_cents': 140},
    });
    expect(q.holdCents, 9000);
    expect(q.firstHourEstimateCents, 1398);
    expect(q.promo!.valid, isTrue);
    expect(q.promo!.discountPreviewCents, 140);
    expect(RentalQuote.fromJson(const {'station_id': 'X'}).promo, isNull);
  });

  testWidgets('quantity stepper respects bounds and reports changes', (t) async {
    var count = 1;
    await t.pumpWidget(wrap(Scaffold(
      body: StatefulBuilder(
        builder: (context, set) => QuantityStepper(count: count, max: 2, onChanged: (n) => set(() => count = n)),
      ),
    )));
    await t.tap(find.byIcon(Icons.add_rounded));
    await t.pump();
    expect(count, 2);
    // At max: the + button is disabled.
    await t.tap(find.byIcon(Icons.add_rounded));
    await t.pump();
    expect(count, 2);
    await t.tap(find.byIcon(Icons.remove_rounded));
    await t.pump();
    expect(count, 1);
    await t.tap(find.byIcon(Icons.remove_rounded));
    await t.pump();
    expect(count, 1);
  });

  testWidgets('checkout renders station, honest hold summary, and gated CTA', (t) async {
    bigSurface(t);
    await t.pumpWidget(wrap(const ConfirmRentalScreen(station: station, pricing: pricing)));
    await t.pump(const Duration(seconds: 2));

    expect(find.text('Complete Your Rental'), findsOneWidget);
    expect(find.text('Standard Rental'), findsOneWidget);
    expect(find.text('Test Mode'), findsOneWidget);
    expect(find.text('Card hold today'), findsOneWidget);
    expect(find.text('\$12.00'), findsOneWidget);
    expect(find.textContaining('non-return fee'), findsWidgets);
    expect(find.text('Have a promo code?'), findsOneWidget);

    // CTA starts disabled: no valid email, no consent.
    FilledButton cta() => t.widget<FilledButton>(find.widgetWithText(FilledButton, 'Continue to Payment  →'));
    expect(cta().onPressed, isNull);

    await t.enterText(find.byType(TextFormField), 'rider@example.com');
    await t.pump();
    expect(cta().onPressed, isNull); // still needs consent

    await t.ensureVisible(find.byType(Checkbox));
    await t.tap(find.byType(Checkbox));
    await t.pump();
    expect(cta().onPressed, isNotNull);
  });

  testWidgets('promo apply hits the server quote and shows applied state', (t) async {
    final api = FakeApi()
      ..quote = const RentalQuote(
        stationId: 'ZN-TEST1', bankCount: 1, readyBanks: 3, holdCents: 4500,
        firstHourEstimateCents: 699, additionalHourCents: 699,
        nonReturnMaxCents: 4500, nonReturnAfterHours: 24,
        promo: QuotePromo(code: 'SAVE10', valid: true, percentOff: 10, discountPreviewCents: 70),
      );
    bigSurface(t);
    await t.pumpWidget(wrap(const ConfirmRentalScreen(station: station, pricing: pricing), api: api));
    await t.pump(const Duration(seconds: 2));

    await t.enterText(find.widgetWithText(TextField, 'Have a promo code?'), 'SAVE10');
    await t.tap(find.widgetWithText(FilledButton, 'Apply'));
    await t.pump(const Duration(seconds: 1));

    expect(api.quoteCalls, 1);
    expect(find.text('Remove'), findsOneWidget);
    expect(find.text('Promo SAVE10 (est.)'), findsOneWidget);
    expect(find.text('-\$0.70'), findsOneWidget);
  });

  testWidgets('invalid promo shows an honest error, not a discount', (t) async {
    final api = FakeApi()
      ..quote = const RentalQuote(
        stationId: 'ZN-TEST1', bankCount: 1, readyBanks: 3, holdCents: 4500,
        firstHourEstimateCents: 699, additionalHourCents: 699,
        nonReturnMaxCents: 4500, nonReturnAfterHours: 24,
        promo: QuotePromo(code: 'NOPE', valid: false),
      );
    bigSurface(t);
    await t.pumpWidget(wrap(const ConfirmRentalScreen(station: station, pricing: pricing), api: api));
    await t.pump(const Duration(seconds: 2));

    await t.enterText(find.widgetWithText(TextField, 'Have a promo code?'), 'NOPE');
    await t.tap(find.widgetWithText(FilledButton, 'Apply'));
    await t.pump(const Duration(seconds: 1));

    expect(find.text('Invalid or expired code.'), findsOneWidget);
    expect(find.text('Remove'), findsNothing);
  });

  test('dispense json parses stage, slot and simulated flag', () {
    final d = DispenseInfo.fromJson(const {
      'stage': 'releasing', 'slot': 3, 'simulated': true, 'commandStatus': 'awaiting_ack',
    });
    expect(d.stage, 'releasing');
    expect(d.progress, 3);
    expect(d.slot, 3);
    expect(d.simulated, isTrue);
    expect(DispenseInfo.fromJson(const {'stage': 'checking'}).isUncertain, isTrue);
    expect(DispenseInfo.fromJson(const {'stage': 'ready'}).isTerminal, isTrue);
  });

  test('rental json carries the backend dispense block', () {
    final r = Rental.fromJson(const {
      'state': 'dispense_pending', 'reference': 'ZR-1',
      'dispense': {'stage': 'dispensing', 'slot': 2},
    });
    expect(r.dispense!.stage, 'dispensing');
    expect(Rental.fromJson(const {'state': 'active', 'reference': 'x'}).dispense, isNull);
  });

  testWidgets('dispensing screen mirrors the backend stage and marks simulated kiosks', (t) async {
    final api = FakeApi()
      ..rentalRows = const [
        Rental(
          state: 'dispense_pending', reference: 'ZR-9', venue: 'Test station', city: '', bankCount: 1,
          dispense: DispenseInfo(stage: 'releasing', slot: 3, simulated: true),
        ),
      ];
    bigSurface(t);
    await t.pumpWidget(wrap(
      DispensingScreen(knownReferences: const {}, checkoutUrl: Uri.parse('https://checkout.test'), stationName: 'Test station', bankCount: 1),
      api: api,
    ));
    await t.pump(const Duration(seconds: 4)); // first poll at 3s
    await t.pump(const Duration(seconds: 1));
    expect(find.text('Preparing Your Charger'), findsWidgets);
    expect(find.text('Releasing charger from slot 3…'), findsOneWidget);
    expect(find.text('SIMULATED KIOSK — TEST MODE'), findsOneWidget);
    expect(find.text('Ready to Pick Up'), findsOneWidget); // stage list row, not the claim
  });

  testWidgets('hardware failure shows honest recovery, never success', (t) async {
    final api = FakeApi()
      ..rentalRows = const [
        Rental(
          state: 'dispense_pending', reference: 'ZR-9', venue: 'Test station', city: '', bankCount: 1,
          dispense: DispenseInfo(stage: 'failed', errorCode: 'slot_jam'),
        ),
      ];
    bigSurface(t);
    await t.pumpWidget(wrap(
      DispensingScreen(knownReferences: const {}, checkoutUrl: Uri.parse('https://checkout.test'), stationName: 'Test station', bankCount: 1),
      api: api,
    ));
    await t.pump(const Duration(seconds: 4));
    await t.pump(const Duration(seconds: 1));
    expect(find.text('We could not finish dispensing'), findsWidgets);
    expect(find.text('Your charger is ready!'), findsNothing);
    expect(find.text('Contact support'), findsOneWidget);
  });

  testWidgets('progress indicator renders the three checkout stages', (t) async {
    await t.pumpWidget(wrap(const Scaffold(body: CheckoutProgress(current: 1))));
    await t.pump();
    expect(find.text('Rental'), findsOneWidget);
    expect(find.text('Payment'), findsOneWidget);
    expect(find.text('Confirmation'), findsOneWidget);
  });
}
