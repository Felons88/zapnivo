import 'dart:convert';

import 'package:http/http.dart' as http;

const apiBase = String.fromEnvironment(
  'ZAPNIVO_API_BASE',
  defaultValue: 'https://api.zapnivo.com',
);
const siteBase = 'https://www.zapnivo.com';

class Station {
  const Station({
    required this.id,
    required this.name,
    required this.address,
    required this.city,
    required this.state,
    required this.lat,
    required this.lng,
    this.hours,
  });

  final String id;
  final String name;
  final String address;
  final String city;
  final String state;
  final double lat;
  final double lng;
  final String? hours;

  factory Station.fromJson(Map<String, dynamic> json) => Station(
    id: json['id'] as String,
    name: json['name'] as String,
    address: json['address'] as String,
    city: json['city'] as String,
    state: json['state'] as String,
    lat: (json['lat'] as num).toDouble(),
    lng: (json['lng'] as num).toDouble(),
    hours: json['hours'] as String?,
  );
}

class RentalPricing {
  const RentalPricing({
    required this.firstHourCents,
    required this.additionalHourCents,
    required this.nonReturnMaxCents,
    required this.nonReturnAfterHours,
  });

  final int firstHourCents;
  final int additionalHourCents;
  final int nonReturnMaxCents;
  final int nonReturnAfterHours;

  factory RentalPricing.fromJson(Map<String, dynamic> json) => RentalPricing(
    firstHourCents: json['first_hour_cents'] as int,
    additionalHourCents: json['additional_hour_cents'] as int,
    nonReturnMaxCents: json['non_return_max_cents'] as int,
    nonReturnAfterHours: json['non_return_after_hours'] as int,
  );
}

class StationSnapshot {
  const StationSnapshot(this.stations, this.pricing);
  final List<Station> stations;
  final RentalPricing? pricing;
}

class ApiException implements Exception {
  const ApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ZapnivoApi {
  ZapnivoApi({http.Client? client}) : _client = client ?? http.Client();
  final http.Client _client;

  Uri _url(String path) => Uri.parse('$apiBase$path');

  Future<StationSnapshot> getStations() async {
    final http.Response response;
    try {
      response = await _client
          .get(_url('/api/mobile/stations'))
          .timeout(const Duration(seconds: 15));
    } catch (_) {
      throw const ApiException(
        'Could not reach Zapnivo. Check your connection and try again.',
      );
    }
    if (response.statusCode != 200) {
      throw const ApiException(
        'Stations are temporarily unavailable. Please try again.',
      );
    }
    try {
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      final stations = (body['stations'] as List<dynamic>)
          .map((item) => Station.fromJson(item as Map<String, dynamic>))
          .toList(growable: false);
      final price = body['pricing'];
      return StationSnapshot(
        stations,
        price == null
            ? null
            : RentalPricing.fromJson(price as Map<String, dynamic>),
      );
    } catch (_) {
      throw const ApiException(
        'Station information could not be read. Please try again.',
      );
    }
  }

  Future<Uri> createCheckout({
    required String stationId,
    required String email,
    required int bankCount,
    String? promoCode,
  }) async {
    final http.Response response;
    try {
      response = await _client
          .post(
            _url('/api/rentals/checkout'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode({
              'station_id': stationId,
              'email': email.trim(),
              'bank_count': bankCount,
              'promo_code': promoCode?.trim(),
              'consent': true,
              'sms_consent': false,
            }),
          )
          .timeout(const Duration(seconds: 25));
    } catch (_) {
      throw const ApiException(
        'Could not reach checkout. Nothing has been charged.',
      );
    }
    Map<String, dynamic> body;
    try {
      body = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      throw const ApiException(
        'Checkout did not respond correctly. Nothing has been charged.',
      );
    }
    if (response.statusCode == 201 && body['checkout_url'] is String) {
      final url = Uri.tryParse(body['checkout_url'] as String);
      if (url != null &&
          url.scheme == 'https' &&
          (url.host == 'checkout.stripe.com' ||
              url.host.endsWith('.stripe.com'))) {
        return url;
      }
      throw const ApiException(
        'Checkout returned an invalid payment link. Nothing has been charged.',
      );
    }
    if (response.statusCode == 503) {
      throw const ApiException(
        'Rentals are not open yet. Nothing has been charged.',
      );
    }
    if (response.statusCode == 409) {
      throw const ApiException(
        'This station cannot start a rental right now. Try another station.',
      );
    }
    if (response.statusCode == 429) {
      throw const ApiException(
        'Too many attempts. Wait a few minutes and try again.',
      );
    }
    final error = body['error'];
    throw ApiException(
      error is String
          ? error
          : 'Checkout could not start. Nothing has been charged.',
    );
  }
}
