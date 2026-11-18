import 'dart:convert';
import 'dart:io';

import 'package:nfc_manager/ndef_record.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager/nfc_manager_android.dart';
import 'package:nfc_manager/nfc_manager_ios.dart';

/// In-app NFC station-tag reading. Tags on machines carry the same NDEF URI as
/// the printed QR (`https://www.zapnivo.com/r/{STATION}`) so the exact same
/// `stationIdFromCode` validation applies — a foreign tag resolves to null and
/// is ignored, never trusted.
class StationNfc {
  static Future<bool> get isAvailable async {
    try {
      return (await NfcManager.instance.checkAvailability()) == NfcAvailability.enabled;
    } catch (_) {
      return false;
    }
  }

  /// Polls for tags; [onRead] fires with the first decodable record's contents
  /// (URI or text — still raw; the caller validates it). The caller owns
  /// session lifetime: call [stop] before navigating away.
  static Future<void> listen(Future<void> Function(String raw) onRead) async {
    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso14443, NfcPollingOption.iso15693, NfcPollingOption.iso18092},
      alertMessageIos: 'Hold near the Zapnivo station tag',
      onDiscovered: (tag) async {
        final raw = await _readTag(tag);
        if (raw != null) await onRead(raw);
      },
    );
  }

  static Future<void> stop() async {
    try {
      await NfcManager.instance.stopSession();
    } catch (_) {}
  }

  static Future<String?> _readTag(NfcTag tag) async {
    NdefMessage? message;
    try {
      if (Platform.isAndroid) {
        final ndef = NdefAndroid.from(tag);
        message = ndef?.cachedNdefMessage ?? await ndef?.getNdefMessage().catchError((_) => null);
      } else if (Platform.isIOS) {
        final ndef = NdefIos.from(tag);
        message = ndef?.cachedNdefMessage ?? await ndef?.readNdef().catchError((_) => null);
      }
    } catch (_) {
      return null;
    }
    if (message == null) return null;
    for (final record in message.records) {
      final value = _recordValue(record);
      if (value != null && value.trim().isNotEmpty) return value.trim();
    }
    return null;
  }

  static String? _recordValue(NdefRecord record) {
    final type = utf8.decode(record.type, allowMalformed: true);
    // RTD URI: first payload byte indexes the prefix table, rest is the suffix.
    if (type == 'U' && record.payload.isNotEmpty) {
      final prefix = record.payload[0] < _uriPrefixes.length ? _uriPrefixes[record.payload[0]] : '';
      return prefix + utf8.decode(record.payload.sublist(1), allowMalformed: true);
    }
    // RTD Text: status byte (utf-8 + lang length), lang code, then text.
    if (type == 'T' && record.payload.isNotEmpty) {
      final langLen = record.payload[0] & 0x3F;
      if (record.payload.length > 1 + langLen) {
        return utf8.decode(record.payload.sublist(1 + langLen), allowMalformed: true);
      }
    }
    return null;
  }
}

const _uriPrefixes = <String>[
  '', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:', 'mailto:',
  'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://', 'sftp://', 'smb://',
  'nfs://', 'ftp://', 'dav://', 'news:', 'telnet://', 'imap:', 'rtsp://',
  'urn:', 'pop:', 'sip:', 'sips:', 'tftp:', 'btspp://', 'btl2cap://',
  'btgoep://', 'tcpobex://', 'irdaobex://', 'file://', 'urn:epc:id:',
  'urn:epc:tag:', 'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:', 'urn:nfc:',
];
