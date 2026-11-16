import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

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
    this.readyBanks,
    this.rentalsAvailable,
  });

  final String id;
  final String name;
  final String address;
  final String city;
  final String state;
  final double? lat;
  final double? lng;
  final String? hours;
  final int? readyBanks;
  final bool? rentalsAvailable;

  factory Station.fromJson(Map<String, dynamic> json) => Station(
    id: json['id'] as String,
    name: json['name'] as String,
    address: json['address'] as String,
    city: json['city'] as String,
    state: json['state'] as String,
    lat: (json['lat'] as num?)?.toDouble(),
    lng: (json['lng'] as num?)?.toDouble(),
    hours: json['hours'] as String?,
    readyBanks: json['ready_banks'] as int?,
    rentalsAvailable: json['rentals_available'] as bool?,
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

class Rental {
  const Rental({
    required this.state,
    required this.reference,
    required this.venue,
    required this.city,
    required this.bankCount,
    this.stationId,
    this.createdAt,
    this.startedAt,
    this.endedAt,
    this.returnDeadline,
    this.amountCents,
    this.authorizedCents,
    this.taxCents,
    this.discountCents,
    this.paymentState,
    this.receiptEmail,
    this.promoCode,
  });

  final String state;
  final String reference;
  final String venue;
  final String city;
  final int bankCount;
  final String? stationId;
  final DateTime? createdAt;
  final DateTime? startedAt;
  final DateTime? endedAt;
  final DateTime? returnDeadline;
  final int? amountCents;
  final int? authorizedCents;
  final int? taxCents;
  final int? discountCents;
  final String? paymentState;
  final String? receiptEmail;
  final String? promoCode;

  static const finished = ['returned', 'closed', 'cancelled', 'charged_off', 'non_return_fee_paid', 'non_return_fee_pending', 'disputed'];
  static const inProgress = ['payment_authorized', 'dispense_pending', 'active', 'return_pending', 'unreturned', 'overdue'];
  static const unpaid = ['authorized', 'pending_payment'];
  bool get isVisible => !unpaid.contains(state);

  /// A rental is "live" once paid/authorized and not finished. Abandoned checkouts stay out of this.
  bool get isActive => inProgress.contains(state);
  bool get isCompleted => state == 'returned' || state == 'closed';
  bool get isOverdue => state == 'unreturned' || state == 'overdue' || (returnDeadline != null && isActive && returnDeadline!.isBefore(DateTime.now()));
  String get stateLabel => switch (state) {
    'payment_authorized' || 'dispense_pending' => 'Dispensing',
    'return_pending' => 'Returning',
    'overdue' => 'Overdue',
    'non_return_fee_paid' || 'non_return_fee_pending' => 'Fee charged',
    'disputed' => 'In review',
    'active' => 'Active',
    'unreturned' => 'Overdue',
    'returned' => 'Returned',
    'closed' => 'Completed',
    'charged_off' => 'Charged off',
    'cancelled' => 'Cancelled',
    'failed' => 'Failed',
    _ => state.replaceAll('_', ' '),
  };

  int? get subtotalCents => amountCents == null ? null : amountCents! + (discountCents ?? 0) - (taxCents ?? 0);

  factory Rental.fromJson(Map<String, dynamic> json) {
    DateTime? date(String key) {
      final v = json[key];
      return v is String ? DateTime.tryParse(v)?.toLocal() : null;
    }

    int? cents(String key) => (json[key] as num?)?.toInt();

    return Rental(
      state: json['state'] as String? ?? 'pending',
      reference: json['reference'] as String? ?? '',
      venue: json['venue'] as String? ?? 'Zapnivo station',
      city: json['city'] as String? ?? '',
      bankCount: (json['bank_count'] as num?)?.toInt() ?? 1,
      stationId: json['station_id'] as String?,
      createdAt: date('created_at'),
      startedAt: date('dispensed_at') ?? date('created_at'),
      endedAt: date('returned_at'),
      returnDeadline: date('return_deadline'),
      amountCents: cents('amount_captured_cents'),
      authorizedCents: cents('amount_authorized_cents'),
      taxCents: cents('tax_cents'),
      discountCents: cents('discount_cents'),
      paymentState: json['payment_state'] as String?,
      receiptEmail: json['receipt_email'] as String?,
      promoCode: json['promo_code'] as String?,
    );
  }
}

class TicketSummary {
  const TicketSummary({required this.number, required this.category, required this.subject, required this.state, required this.createdAt, this.rentalRef});
  final String number;
  final String category;
  final String subject;
  final String state;
  final DateTime? createdAt;
  final String? rentalRef;
  bool get isOpen => state != 'resolved' && state != 'closed';
  String get stateLabel => switch (state) {
    'open' => 'Open',
    'pending_customer' => 'Needs your reply',
    'pending_internal' => 'In review',
    'resolved' => 'Resolved',
    'closed' => 'Closed',
    _ => state.replaceAll('_', ' '),
  };
  factory TicketSummary.fromJson(Map<String, dynamic> j) => TicketSummary(
    number: j['number'] as String,
    category: j['category'] as String? ?? '',
    subject: j['subject'] as String? ?? '',
    state: j['state'] as String? ?? 'open',
    createdAt: DateTime.tryParse(j['created_at'] as String? ?? '')?.toLocal(),
    rentalRef: j['rental_ref'] as String?,
  );
}

class TicketMessage {
  const TicketMessage({required this.author, required this.authorType, required this.body, required this.createdAt});
  final String author;
  final String authorType;
  final String body;
  final DateTime? createdAt;
  bool get mine => authorType == 'customer';
  factory TicketMessage.fromJson(Map<String, dynamic> j) => TicketMessage(
    author: j['authorName'] as String? ?? '',
    authorType: j['authorType'] as String? ?? 'agent',
    body: j['body'] as String? ?? '',
    createdAt: DateTime.tryParse(j['createdAt'] as String? ?? '')?.toLocal(),
  );
}

class TicketThread {
  const TicketThread({required this.number, required this.category, required this.subject, required this.state, required this.withPerson, required this.messages});
  final String number;
  final String category;
  final String subject;
  final String state;
  final bool withPerson;
  final List<TicketMessage> messages;
  bool get isOpen => state != 'resolved' && state != 'closed';
  factory TicketThread.fromJson(Map<String, dynamic> j) => TicketThread(
    number: j['number'] as String,
    category: j['category'] as String? ?? '',
    subject: j['subject'] as String? ?? '',
    state: j['state'] as String? ?? 'open',
    withPerson: j['withPerson'] == true,
    messages: ((j['messages'] as List<dynamic>?) ?? const []).map((m) => TicketMessage.fromJson(m as Map<String, dynamic>)).toList(),
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
  Map<String, String> get _authHeaders {
    final token = Supabase.instance.client.auth.currentSession?.accessToken;
    return {'Authorization': 'Bearer ${token ?? ''}'};
  }

  Future<Map<String, dynamic>> account() => _protected('GET', '/api/mobile/me');
  Future<List<dynamic>> rentals() async =>
      (await _protected('GET', '/api/mobile/rentals'))['rentals'] as List<dynamic>;

  Future<List<Rental>> rentalList() async => (await rentals())
      .map((e) => Rental.fromJson(e as Map<String, dynamic>))
      .where((r) => r.isVisible)
      .toList(growable: false);

  Future<void> updateProfile({String? name, bool? notifySms}) => _protected('PATCH', '/api/mobile/me', body: {
    if (name != null) 'name': name,
    if (notifySms != null) 'notify_sms': notifySms,
  });

  Future<void> requestAccountDeletion() => _protected('DELETE', '/api/mobile/me');

  Future<({List<TicketSummary> tickets, List<String> categories})> tickets() async {
    final b = await _protected('GET', '/api/mobile/tickets');
    return (
      tickets: ((b['tickets'] as List<dynamic>?) ?? const []).map((e) => TicketSummary.fromJson(e as Map<String, dynamic>)).toList(),
      categories: ((b['categories'] as List<dynamic>?) ?? const []).cast<String>(),
    );
  }

  Future<String> createTicket({required String category, required String description, String? rentalRef}) async {
    final b = await _protected('POST', '/api/mobile/tickets', body: {'category': category, 'description': description, 'rental_ref': rentalRef ?? ''});
    return b['number'] as String;
  }

  Future<TicketThread> ticketThread(String number) async =>
      TicketThread.fromJson(await _protected('GET', '/api/mobile/tickets/${Uri.encodeComponent(number)}'));

  Future<TicketThread> ticketAction(String number, String action, {String? body}) async => TicketThread.fromJson(
    await _protected('POST', '/api/mobile/tickets/${Uri.encodeComponent(number)}', body: {'action': action, 'body': ?body}),
  );

  Future<void> registerDevice(String token, String version) =>
      _protected('POST', '/api/mobile/devices', body: {'token': token, 'platform': 'android', 'app_version': version});

  Future<void> unregisterDevice(String token) => _protected('DELETE', '/api/mobile/devices', body: {'token': token});

  Future<Map<String, dynamic>> _protected(String method, String path, {Map<String, dynamic>? body, bool retried = false}) async {
    final http.Response response;
    try {
      final request = http.Request(method, _url(path))
        ..headers.addAll({..._authHeaders, if (body != null) 'Content-Type': 'application/json'});
      if (body != null) request.body = jsonEncode(body);
      response = await http.Response.fromStream(await _client.send(request).timeout(const Duration(seconds: 20)));
    } catch (_) {
      throw const ApiException('Could not connect. Check your connection and try again.');
    }
    if (response.statusCode == 401 && !retried) {
      try {
        await Supabase.instance.client.auth.refreshSession();
        return await _protected(method, path, body: body, retried: true);
      } catch (_) {
        throw const ApiException('Your session expired. Log in again.');
      }
    }
    Map<String, dynamic> data = {};
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) data = decoded;
    } catch (_) {}
    if (response.statusCode == 401) throw const ApiException('Your session expired. Log in again.');
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final msg = data['error'];
      throw ApiException(msg is String ? msg : 'Something went wrong (code ${response.statusCode}). Please try again.');
    }
    return data;
  }

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

  Future<({Station station, RentalPricing? pricing})> getStation(
    String id,
  ) async {
    final http.Response response;
    try {
      response = await _client
          .get(_url('/api/mobile/stations/${Uri.encodeComponent(id)}'))
          .timeout(const Duration(seconds: 15));
    } catch (_) {
      throw const ApiException(
        'Could not check this station. Try again when connected.',
      );
    }
    if (response.statusCode == 404) {
      throw const ApiException(
        'This station is not available for rentals. Check the ID on the QR label.',
      );
    }
    if (response.statusCode != 200) {
      throw const ApiException(
        'Station details are temporarily unavailable. Please try again.',
      );
    }
    try {
      final body = jsonDecode(response.body) as Map<String, dynamic>;
      final price = body['pricing'];
      return (
        station: Station.fromJson(body['station'] as Map<String, dynamic>),
        pricing: price == null
            ? null
            : RentalPricing.fromJson(price as Map<String, dynamic>),
      );
    } catch (_) {
      throw const ApiException(
        'Station details could not be read. Please try again.',
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
            headers: {'Content-Type': 'application/json', ..._authHeaders},
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
