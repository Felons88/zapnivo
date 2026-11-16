import 'package:flutter_test/flutter_test.dart';
import 'package:zapnivo_mobile/qr_parser.dart';

void main() {
  test('accepts station QR URLs and manual IDs', () {
    expect(stationIdFromCode('https://www.zapnivo.com/r/MN-001'), 'MN-001');
    expect(
      stationIdFromCode('https://zapnivo.com/r/MN-001?source=qr'),
      'MN-001',
    );
    expect(stationIdFromCode('MN-001'), 'MN-001');
    expect(stationIdFromCode('mn-001'), 'MN-001');
    expect(stationIdFromCode('https://zapnivo.com/r/mn-001'), 'MN-001');
  });

  test('rejects foreign and malformed QR codes', () {
    expect(stationIdFromCode('https://example.com/r/MN-001'), isNull);
    expect(stationIdFromCode('https://zapnivo.com.evil.test/r/MN-001'), isNull);
    expect(stationIdFromCode('http://zapnivo.com/r/MN-001'), isNull);
    expect(stationIdFromCode('https://zapnivo.com/account'), isNull);
    expect(stationIdFromCode('x'), isNull);
  });
}
