import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:url_launcher/url_launcher.dart' show LaunchMode;

import 'api.dart';

const authRedirect = 'com.zapnivo.mobile://auth-callback/';

class MobileAuthConfig {
  const MobileAuthConfig({required this.url, required this.anonKey,
    required this.phoneSignInAvailable});
  final String url;
  final String anonKey;
  final bool phoneSignInAvailable;
}

class SecureSessionStorage extends LocalStorage {
  const SecureSessionStorage();
  static const _storage = FlutterSecureStorage();
  static const _key = 'zapnivo_supabase_session';

  @override
  Future<void> initialize() async {}
  @override
  Future<bool> hasAccessToken() async => await _storage.containsKey(key: _key);
  @override
  Future<String?> accessToken() => _storage.read(key: _key);
  @override
  Future<void> persistSession(String value) => _storage.write(key: _key, value: value);
  @override
  Future<void> removePersistedSession() => _storage.delete(key: _key);
}

class MobileAuth {
  MobileAuth({http.Client? client}) : _client = client ?? http.Client();
  final http.Client _client;
  SupabaseClient get supabase => Supabase.instance.client;
  String? get accessToken => supabase.auth.currentSession?.accessToken;

  Future<MobileAuthConfig> loadConfig() async {
    final http.Response response;
    try {
      response = await _client.get(Uri.parse('$apiBase/api/mobile/config'))
        .timeout(const Duration(seconds: 15));
    } catch (_) {
      throw const ApiException('Could not connect to Zapnivo. Check your connection and retry.');
    }
    if (response.statusCode != 200) {
      throw const ApiException('Mobile sign-in is temporarily unavailable.');
    }
    try {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return MobileAuthConfig(url: data['supabase_url'] as String,
        anonKey: data['supabase_anon_key'] as String,
        phoneSignInAvailable: data['phone_sign_in_available'] == true);
    } catch (_) {
      throw const ApiException('Sign-in configuration could not be read.');
    }
  }

  Future<void> initialize(MobileAuthConfig config) => Supabase.initialize(
    url: config.url, publishableKey: config.anonKey,
    authOptions: const FlutterAuthClientOptions(localStorage: SecureSessionStorage()),
  ).then((_) {});

  Future<void> signInWithGoogle() async {
    try {
      final started = await supabase.auth.signInWithOAuth(OAuthProvider.google,
        redirectTo: authRedirect, authScreenLaunchMode: LaunchMode.externalApplication);
      if (!started) throw const ApiException('Google sign-in could not start.');
    } on AuthException catch (e) {
      throw ApiException(e.message);
    }
  }

  Future<void> sendPhoneCode(String phone) async {
    final data = await _phoneRequest({'action': 'send', 'phone': phone});
    if (data['ok'] != true) throw const ApiException('Code could not be sent.');
  }

  Future<void> verifyPhoneCode(String phone, String code) async {
    final data = await _phoneRequest({'action': 'verify', 'phone': phone, 'code': code});
    final access = data['access_token'];
    final refresh = data['refresh_token'];
    if (access is! String || refresh is! String) {
      throw const ApiException('Sign-in did not finish. Request a new code.');
    }
    try {
      final response = await supabase.auth.setSession(refresh, accessToken: access);
      if (response.session == null) throw const ApiException('Sign-in did not finish. Request a new code.');
    } on AuthException catch (e) {
      throw ApiException(e.message);
    }
  }

  Future<Map<String, dynamic>> _phoneRequest(Map<String, String> body) async {
    final http.Response response;
    try {
      response = await _client.post(Uri.parse('$apiBase/api/mobile/auth/phone'),
        headers: {'Content-Type': 'application/json'}, body: jsonEncode(body))
        .timeout(const Duration(seconds: 25));
    } catch (_) {
      throw const ApiException('Could not reach sign-in. Check your connection.');
    }
    Map<String, dynamic> data;
    try { data = jsonDecode(response.body) as Map<String, dynamic>; }
    catch (_) { throw const ApiException('Sign-in returned an invalid response.'); }
    if (response.statusCode != 200) {
      throw ApiException(data['error'] is String ? data['error'] as String : 'Sign-in did not work. Try again.');
    }
    return data;
  }
}
