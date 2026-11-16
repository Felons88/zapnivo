import 'package:flutter_test/flutter_test.dart';
import 'package:zapnivo_mobile/api.dart';

void main() {
  test('maps server amounts, tax, discount and deadline', () {
    final r = Rental.fromJson({
      'reference': 'ZP-1', 'state': 'returned', 'bank_count': 2, 'venue': 'Cafe', 'city': 'Saint Paul',
      'created_at': '2026-11-16T10:00:00Z', 'dispensed_at': '2026-11-16T10:05:00Z', 'returned_at': '2026-11-16T12:10:00Z',
      'return_deadline': '2026-11-17T10:05:00Z', 'amount_captured_cents': 2200, 'tax_cents': 200, 'discount_cents': 500,
    });
    expect(r.amountCents, 2200);
    expect(r.subtotalCents, 2500);
    expect(r.isCompleted, isTrue);
    expect(r.isActive, isFalse);
    expect(r.returnDeadline, isNotNull);
  });

  test('unpaid checkouts are hidden and never counted as active', () {
    final r = Rental.fromJson({'reference': 'ZP-2', 'state': 'authorized'});
    expect(r.isVisible, isFalse);
    expect(r.isActive, isFalse);
    expect(Rental.fromJson({'reference': 'ZP-3', 'state': 'active'}).isActive, isTrue);
    expect(Rental.fromJson({'reference': 'ZP-4', 'state': 'dispense_pending'}).isActive, isTrue);
  });
}
