import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'animations.dart';
import 'theme.dart';

/// Airbnb/Uber-style list row: icon, label, chevron, hairline divider. No card chrome.
class SettingsRow extends StatelessWidget {
  const SettingsRow({super.key, required this.icon, required this.label, this.subtitle, this.trailing, this.onTap, this.color, this.divider = true});
  final IconData icon;
  final String label;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final Color? color;
  final bool divider;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 20),
          child: Row(
            children: [
              Icon(icon, size: 27, color: color ?? Colors.white),
              const SizedBox(width: 20),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: TextStyle(fontSize: 17.5, color: color ?? Colors.white, fontWeight: FontWeight.w500)),
                    if (subtitle != null) Padding(padding: const EdgeInsets.only(top: 3), child: Text(subtitle!, style: const TextStyle(color: muted, fontSize: 13.5))),
                  ],
                ),
              ),
              trailing ?? (onTap == null ? const SizedBox.shrink() : const Icon(Icons.chevron_right_rounded, color: muted, size: 26)),
            ],
          ),
        ),
        if (divider) Divider(height: 1, color: Colors.white.withValues(alpha: 0.1)),
      ],
    ),
  );
}

class BigTitle extends StatelessWidget {
  const BigTitle(this.text, {super.key, this.padding = const EdgeInsets.fromLTRB(24, 8, 24, 20)});
  final String text;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) =>
      Padding(padding: padding, child: Text(text, style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w800, letterSpacing: -1.1, height: 1.05)));
}

class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.fromLTRB(0, 28, 0, 4), child: Text(text, style: const TextStyle(color: muted, fontWeight: FontWeight.w700, fontSize: 13, letterSpacing: 0.4)));
}

/// Round back button used on full-screen pages.
class RoundBack extends StatelessWidget {
  const RoundBack({super.key});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(20, 8, 0, 4),
    child: Align(
      alignment: Alignment.centerLeft,
      child: Glass(radius: 22, padding: const EdgeInsets.all(10), onTap: () => Navigator.of(context).maybePop(), child: const Icon(Icons.arrow_back_rounded, size: 22)),
    ),
  );
}

/// A full page with the big-title layout (matches the settings screenshot).
class TitledPage extends StatelessWidget {
  const TitledPage({super.key, required this.title, required this.children, this.footer, this.onRefresh});
  final String title;
  final List<Widget> children;
  final Widget? footer;
  final Future<void> Function()? onRefresh;
  @override
  Widget build(BuildContext context) {
    final list = ListView(
      padding: const EdgeInsets.only(bottom: 40),
      children: [
        const RoundBack(),
        BigTitle(title),
        ...stagger([for (final c in children) Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: c)]),
        ?footer,
      ],
    );
    return Scaffold(body: SafeArea(child: onRefresh == null ? list : RefreshIndicator(onRefresh: onRefresh!, child: list)));
  }
}

/// Shows an existing page inside the app (no external browser): legal text, help articles.
class InAppPage extends StatefulWidget {
  const InAppPage({super.key, required this.title, required this.url});
  final String title;
  final String url;
  @override
  State<InAppPage> createState() => _InAppPageState();
}

class _InAppPageState extends State<InAppPage> {
  late final WebViewController controller;
  bool loading = true;

  @override
  void initState() {
    super.initState();
    controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(ink)
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (_) => mounted ? setState(() => loading = false) : null,
        onNavigationRequest: (r) => Uri.tryParse(r.url)?.host.endsWith('zapnivo.com') == true ? NavigationDecision.navigate : NavigationDecision.prevent,
      ))
      ..loadRequest(Uri.parse(widget.url));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: Text(widget.title)),
    body: Stack(children: [WebViewWidget(controller: controller), if (loading) const Center(child: CircularProgressIndicator(color: lime))]),
  );
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, required this.body, this.action});
  final IconData icon;
  final String title;
  final String body;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 36),
    child: Column(
      children: [
        Icon(icon, size: 56, color: muted),
        const SizedBox(height: 16),
        Text(title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        Text(body, textAlign: TextAlign.center, style: const TextStyle(color: muted, height: 1.45)),
        if (action != null) ...[const SizedBox(height: 14), action!],
      ],
    ),
  );
}
