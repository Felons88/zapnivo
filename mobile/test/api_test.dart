import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:zapnivo_mobile/api.dart';

void main() {
  test('direct lookup works without map coordinates', () async {
    final api = ZapnivoApi(client: MockClient((request) async {
      expect(request.url.path, '/api/mobile/stations/MN-001');
      return http.Response('''{"station":{"id":"MN-001","name":"Test venue",
        "address":"1 Main St","city":"Saint Paul","state":"MN",
        "lat":null,"lng":null,"ready_banks":1,"rentals_available":true},
        "pricing":null}''', 200);
    }));
    final detail = await api.getStation('MN-001');
    expect(detail.station.lat, isNull);
    expect(detail.station.readyBanks, 1);
    expect(detail.station.rentalsAvailable, isTrue);
  });

  test(
    'loads only stations and approved pricing returned by the server',
    () async {
      final api = ZapnivoApi(
        client: MockClient((request) async {
          expect(request.url.path, '/api/mobile/stations');
          return http.Response('''{
        "stations": [{"id":"MN-001","name":"Test venue","address":"1 Main St",
          "city":"Saint Paul","state":"MN","lat":44.9,"lng":-93.1,"hours":null}],
        "pricing": null
      }''', 200);
        }),
      );

      final snapshot = await api.getStations();
      expect(snapshot.stations.single.id, 'MN-001');
      expect(snapshot.pricing, isNull);
    },
  );

  test(
    'does not invent checkout when the backend has not approved pricing',
    () async {
      final api = ZapnivoApi(
        client: MockClient((request) async {
          expect(request.method, 'POST');
          expect(request.url.path, '/api/rentals/checkout');
          expect(request.body, contains('"station_id":"MN-001"'));
          return http.Response(
            '{"error":"Pricing has not been approved yet."}',
            503,
          );
        }),
      );

      expect(
        () => api.createCheckout(
          stationId: 'MN-001',
          email: 'rider@example.com',
          bankCount: 1,
        ),
        throwsA(isA<ApiException>()),
      );
    },
  );

  test('accepts only Stripe HTTPS checkout links', () async {
    final api = ZapnivoApi(
      client: MockClient(
        (_) async =>
            http.Response('{"checkout_url":"https://example.com/fake"}', 201),
      ),
    );
    expect(
      () => api.createCheckout(
        stationId: 'MN-001',
        email: 'rider@example.com',
        bankCount: 1,
      ),
      throwsA(isA<ApiException>()),
    );
  });
}
