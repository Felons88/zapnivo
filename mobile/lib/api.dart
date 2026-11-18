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
    this.testMode = false,
    this.stationState,
    this.slotCount,
    this.venueType,
    this.zip,
    this.phone,
    this.website,
    this.description,
    this.accessibility,
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
  /// Staff-flagged development station — the app must label it, never present it as a public venue.
  final bool testMode;
  /// Backend-derived operational status: available | offline | maintenance | stale.
  /// Older servers don't send it — availability helpers fall back to readyBanks.
  final String? stationState;
  final int? slotCount;
  final String? venueType;
  final String? zip;
  final String? phone;
  final String? website;
  final String? description;
  final String? accessibility;

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
    testMode: json['test_mode'] == true,
    stationState: json['station_state'] as String?,
    slotCount: json['slot_count'] as int?,
    venueType: json['venue_type'] as String?,
    zip: json['zip'] as String?,
    phone: json['phone'] as String?,
    website: json['website'] as String?,
    description: json['description'] as String?,
    accessibility: json['accessibility'] as String?,
  );
}

class RentalPricing {
  const RentalPricing({
    required this.firstHourCents,
    required this.additionalHourCents,
    required this.nonReturnMaxCents,
    required this.nonReturnAfterHours,
    required this.holdCentsPerBank,
  });

  final int firstHourCents;
  final int additionalHourCents;
  final int nonReturnMaxCents;
  final int nonReturnAfterHours;
  /// Card authorization per bank — decoupled from the non-return fee, which
  /// bills separately off-session.
  final int holdCentsPerBank;

  factory RentalPricing.fromJson(Map<String, dynamic> json) => RentalPricing(
    firstHourCents: json['first_hour_cents'] as int,
    additionalHourCents: json['additional_hour_cents'] as int,
    nonReturnMaxCents: json['non_return_max_cents'] as int,
    nonReturnAfterHours: json['non_return_after_hours'] as int,
    holdCentsPerBank: (json['hold_cents'] as num?)?.toInt() ?? (json['non_return_max_cents'] as int),
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
    this.dispense,
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
  final DispenseInfo? dispense;

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
      dispense: json['dispense'] is Map<String, dynamic>
          ? DispenseInfo.fromJson(json['dispense'] as Map<String, dynamic>)
          : null,
    );
  }
}

/// Backend-derived dispense progress — the normalized stage computed from
/// durable `device_commands` + `device_events` rows (server-side
/// `dispenseStatusFor`). The UI mirrors this state only; nothing in the app
/// decides when a dispense succeeded.
class DispenseInfo {
  const DispenseInfo({
    required this.stage,
    this.slot,
    this.errorCode,
    this.simulated = false,
    this.commandStatus,
    this.updatedAt,
  });

  /// connecting | verifying | preparing | releasing | dispensing |
  /// almost_ready | ready | failed | checking
  final String stage;
  final int? slot;
  final String? errorCode;
  final bool simulated;
  final String? commandStatus;
  final DateTime? updatedAt;

  /// Monotonic progress index (terminal failure kinds share -1) — lets the UI
  /// refuse to regress from a later stage to a stale earlier one.
  int get progress => switch (stage) {
        'connecting' => 0,
        'verifying' => 1,
        'preparing' => 2,
        'releasing' => 3,
        'dispensing' => 4,
        'almost_ready' => 5,
        'ready' => 6,
        _ => -1,
      };

  bool get isTerminal => stage == 'ready' || stage == 'failed';
  bool get isUncertain => stage == 'checking';

  factory DispenseInfo.fromJson(Map<String, dynamic> j) => DispenseInfo(
        stage: j['stage'] as String? ?? 'connecting',
        slot: (j['slot'] as num?)?.toInt(),
        errorCode: j['errorCode'] as String?,
        simulated: j['simulated'] == true,
        commandStatus: j['commandStatus'] as String?,
        updatedAt: j['updatedAt'] is String ? DateTime.tryParse(j['updatedAt'] as String)?.toLocal() : null,
      );
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

/// A persistent notification-center entry (server is the source of truth —
/// read state syncs across devices through the same API).
class AppNotification {
  const AppNotification({required this.id, required this.category, required this.kind, required this.title, required this.body, this.deepLink, required this.read, this.createdAt});
  final String id;
  final String category;
  final String kind;
  final String title;
  final String body;
  final String? deepLink;
  final bool read;
  final DateTime? createdAt;
  factory AppNotification.fromJson(Map<String, dynamic> j) => AppNotification(
    id: j['id'] as String,
    category: j['category'] as String? ?? 'account',
    kind: j['kind'] as String? ?? '',
    title: j['title'] as String? ?? '',
    body: j['body'] as String? ?? '',
    deepLink: j['deepLink'] as String?,
    read: j['read'] == true,
    createdAt: DateTime.tryParse(j['createdAt'] as String? ?? '')?.toLocal(),
  );
}

/// Server-issued checkout quote. All amounts are authoritative cents computed
/// on the server — the app renders them verbatim and never derives prices.
class RentalQuote {
  const RentalQuote({
    required this.stationId,
    required this.bankCount,
    required this.readyBanks,
    required this.holdCents,
    required this.firstHourEstimateCents,
    required this.additionalHourCents,
    required this.nonReturnMaxCents,
    required this.nonReturnAfterHours,
    this.promo,
  });

  final String stationId;
  final int bankCount;
  final int readyBanks;
  final int holdCents;
  final int firstHourEstimateCents;
  final int additionalHourCents;
  final int nonReturnMaxCents;
  final int nonReturnAfterHours;
  final QuotePromo? promo;

  factory RentalQuote.fromJson(Map<String, dynamic> json) => RentalQuote(
    stationId: json['station_id'] as String? ?? '',
    bankCount: (json['bank_count'] as num?)?.toInt() ?? 1,
    readyBanks: (json['ready_banks'] as num?)?.toInt() ?? 0,
    holdCents: (json['hold_cents'] as num?)?.toInt() ?? 0,
    firstHourEstimateCents: (json['first_hour_estimate_cents'] as num?)?.toInt() ?? 0,
    additionalHourCents: (json['additional_hour_cents'] as num?)?.toInt() ?? 0,
    nonReturnMaxCents: (json['non_return_max_cents'] as num?)?.toInt() ?? 0,
    nonReturnAfterHours: (json['non_return_after_hours'] as num?)?.toInt() ?? 0,
    promo: json['promo'] is Map<String, dynamic> ? QuotePromo.fromJson(json['promo'] as Map<String, dynamic>) : null,
  );
}

class QuotePromo {
  const QuotePromo({required this.code, required this.valid, this.percentOff, this.amountOffCents, this.discountPreviewCents});
  final String code;
  final bool valid;
  final double? percentOff;
  final int? amountOffCents;
  /// Estimated discount on the first-hour charge. The real discount is
  /// recomputed at settlement from actual usage.
  final int? discountPreviewCents;

  factory QuotePromo.fromJson(Map<String, dynamic> json) => QuotePromo(
    code: json['code'] as String? ?? '',
    valid: json['valid'] == true,
    percentOff: (json['percent_off'] as num?)?.toDouble(),
    amountOffCents: (json['amount_off_cents'] as num?)?.toInt(),
    discountPreviewCents: (json['discount_preview_cents'] as num?)?.toInt(),
  );
}

/// How the server wants checkout completed: in-app PaymentSheet or hosted Stripe URL.
class CheckoutInit {
  const CheckoutInit._({this.hostedUrl, this.publishableKey, this.paymentIntentClientSecret, this.ephemeralKey, this.customerId, this.merchantDisplayName = 'Zapnivo'});
  factory CheckoutInit.hosted(Uri url) => CheckoutInit._(hostedUrl: url);
  factory CheckoutInit.sheet({required String publishableKey, required String paymentIntentClientSecret, required String ephemeralKey, required String customerId, String merchantDisplayName = 'Zapnivo'}) =>
      CheckoutInit._(publishableKey: publishableKey, paymentIntentClientSecret: paymentIntentClientSecret, ephemeralKey: ephemeralKey, customerId: customerId, merchantDisplayName: merchantDisplayName);
  final Uri? hostedUrl;
  final String? publishableKey;
  final String? paymentIntentClientSecret;
  final String? ephemeralKey;
  final String? customerId;
  final String merchantDisplayName;
  bool get isSheet => paymentIntentClientSecret != null;
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
  Future<Map<String, dynamic>> wallet() => _protected('GET', '/api/mobile/wallet');
  Future<Map<String, dynamic>> walletCard() => _protected('GET', '/api/mobile/wallet/card');
  Future<Map<String, dynamic>> linkedCards() => _protected('GET', '/api/mobile/wallet/cards');
  Future<Map<String, dynamic>> startWalletTopup(int amountCents) =>
      _protected('POST', '/api/mobile/wallet/topups', body: {'amount_cents': amountCents});
  Future<Map<String, dynamic>> googleWalletPass() => _protected('GET', '/api/mobile/wallet/google-pass');
  Future<List<dynamic>> rentals() async =>
      (await _protected('GET', '/api/mobile/rentals'))['rentals'] as List<dynamic>;

  /// Tells the server which dock the customer scanned. On test-mode kiosks the
  /// server runs a simulated dock sequence through the real pipeline; physical
  /// kiosks ignore it (their dock sensor is the source of truth).
  Future<Map<String, dynamic>> returnScan(String stationId) =>
      _protected('POST', '/api/mobile/rentals/return', body: {'station_id': stationId});

  Future<List<Rental>> rentalList() async => (await rentals())
      .map((e) => Rental.fromJson(e as Map<String, dynamic>))
      .where((r) => r.isVisible)
      .toList(growable: false);

  Future<Map<String, dynamic>> updateProfile({String? name, bool? notifySms, String? phone, String? otp, String? email}) =>
      _protected('PATCH', '/api/mobile/me', body: {
        if (name != null) 'name': name,
        if (notifySms != null) 'notify_sms': notifySms,
        if (phone != null) 'phone': phone,
        if (otp != null) 'otp': otp,
        if (email != null) 'email': email,
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

  /// Paginated notification-center feed — newest first. `before` is the
  /// created_at cursor from the previous page's `nextBefore`.
  Future<({List<AppNotification> items, int unread, String? nextBefore})> notifications({
    String? category, bool unreadOnly = false, String? before, int limit = 25,
  }) async {
    final q = Uri(queryParameters: {
      if (category != null) 'category': category,
      if (unreadOnly) 'unread': '1',
      if (before != null) 'before': before,
      'limit': '$limit',
    }).query;
    final b = await _protected('GET', '/api/mobile/notifications?$q');
    return (
      items: ((b['items'] as List<dynamic>?) ?? const []).map((e) => AppNotification.fromJson(e as Map<String, dynamic>)).toList(),
      unread: (b['unread'] as num?)?.toInt() ?? 0,
      nextBefore: b['nextBefore'] as String?,
    );
  }

  Future<void> markNotification(String id, {bool unread = false}) =>
      _protected('PATCH', '/api/mobile/notifications', body: {'id': id, 'unread': unread});

  Future<void> markAllNotificationsRead() =>
      _protected('PATCH', '/api/mobile/notifications', body: {'all': true});

  Future<Map<String, dynamic>> notificationPrefs() => _protected('GET', '/api/mobile/notifications/prefs');

  Future<void> updateNotificationPrefs(Map<String, dynamic> prefs) =>
      _protected('PUT', '/api/mobile/notifications/prefs', body: prefs);

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
          .get(_url('/api/mobile/stations'), headers: _authHeaders)
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

  /// Read-only quote: re-validates the station, refreshes pricing and inventory,
  /// and validates a promo code without reserving it. Amounts returned are
  /// authoritative — render them verbatim.
  Future<RentalQuote> checkoutQuote({required String stationId, required int bankCount, String? promoCode}) async {
    final body = await _protected('POST', '/api/mobile/checkout/quote', body: {
      'station_id': stationId,
      'bank_count': bankCount,
      if (promoCode != null && promoCode.trim().isNotEmpty) 'promo_code': promoCode.trim(),
    });
    return RentalQuote.fromJson(body['quote'] as Map<String, dynamic>? ?? const {});
  }

  Future<CheckoutInit> createCheckout({
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
              'client': 'app',
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
    if (response.statusCode == 201 && body['mode'] == 'payment_sheet') {
      final pk = body['publishable_key'];
      final secret = body['payment_intent_client_secret'];
      final ek = body['ephemeral_key'];
      final customer = body['customer_id'];
      if (pk is String && secret is String && ek is String && customer is String) {
        return CheckoutInit.sheet(
          publishableKey: pk,
          paymentIntentClientSecret: secret,
          ephemeralKey: ek,
          customerId: customer,
          merchantDisplayName: body['merchant_display_name'] is String ? body['merchant_display_name'] as String : 'Zapnivo',
        );
      }
      throw const ApiException(
        'Checkout returned an invalid payment sheet. Nothing has been charged.',
      );
    }
    if (response.statusCode == 201 && body['checkout_url'] is String) {
      final url = Uri.tryParse(body['checkout_url'] as String);
      if (url != null &&
          url.scheme == 'https' &&
          (url.host == 'checkout.stripe.com' ||
              url.host.endsWith('.stripe.com'))) {
        return CheckoutInit.hosted(url);
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
