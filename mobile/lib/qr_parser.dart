/// Station QR codes are website rental URLs. Manual entry accepts a station ID.
/// Never follow an arbitrary QR URL or treat a foreign site's path as a station.
String? stationIdFromCode(String raw) {
  final code = raw.trim();
  final idPattern = RegExp(r'^[A-Za-z0-9_-]{3,40}$');
  if (idPattern.hasMatch(code)) return code.toUpperCase();

  final url = Uri.tryParse(code);
  if (url == null ||
      url.scheme != 'https' ||
      (url.host != 'zapnivo.com' && url.host != 'www.zapnivo.com') ||
      url.pathSegments.length != 2 ||
      url.pathSegments.first != 'r') {
    return null;
  }
  final id = url.pathSegments.last;
  return idPattern.hasMatch(id) ? id.toUpperCase() : null;
}
