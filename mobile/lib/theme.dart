import 'dart:ui';

import 'package:flutter/material.dart';

import 'animations.dart';

const ink = Color(0xFF0B0D24);
const inkSoft = Color(0xFF1A1D44);
const lime = Color(0xFFDCFF70);
const paper = Color(0xFFF6F7F4);
const muted = Color(0xFFA9ACC4);
const danger = Color(0xFFFF8A8A);

ThemeData buildTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: Colors.transparent,
    colorScheme: ColorScheme.fromSeed(
      seedColor: lime,
      brightness: Brightness.dark,
      primary: lime,
      onPrimary: ink,
      secondary: lime,
      surface: ink,
    ),
  );
  return base.copyWith(
    pageTransitionsTheme: const PageTransitionsTheme(builders: {
      TargetPlatform.android: ZapPageTransitions(),
      TargetPlatform.iOS: ZapPageTransitions(),
    }),
    textTheme: base.textTheme.apply(bodyColor: Colors.white, displayColor: Colors.white),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      foregroundColor: Colors.white,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: true,
      titleTextStyle: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: Colors.white),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white.withValues(alpha: 0.08),
      labelStyle: const TextStyle(color: muted),
      hintStyle: const TextStyle(color: muted),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.18)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: BorderSide(color: Colors.white.withValues(alpha: 0.18)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(16),
        borderSide: const BorderSide(color: lime, width: 1.5),
      ),
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: inkSoft,
      contentTextStyle: const TextStyle(color: Colors.white),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: inkSoft,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith(
        (s) => s.contains(WidgetState.selected) ? lime : Colors.transparent,
      ),
      checkColor: const WidgetStatePropertyAll(ink),
      side: const BorderSide(color: muted, width: 1.5),
    ),
  );
}

class AppBackdrop extends StatelessWidget {
  const AppBackdrop({super.key, required this.child});
  final Widget child;
  @override
  Widget build(BuildContext context) => Stack(
    fit: StackFit.expand,
    children: [
      const DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Color(0xFF14173F), ink],
          ),
        ),
      ),
      Positioned(top: -90, right: -70, child: _blob(260, lime.withValues(alpha: 0.22))),
      Positioned(bottom: 120, left: -110, child: _blob(280, const Color(0xFF4B54FF).withValues(alpha: 0.22))),
      child,
    ],
  );

  Widget _blob(double size, Color color) => IgnorePointer(
    child: Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(colors: [color, color.withValues(alpha: 0)]),
      ),
    ),
  );
}

/// Frosted "liquid glass" surface: blur + translucent gradient + specular rim.
class Glass extends StatelessWidget {
  const Glass({
    super.key,
    required this.child,
    this.radius = 24,
    this.padding = const EdgeInsets.all(18),
    this.onTap,
    this.tint,
    this.blur = 22,
  });
  final Widget child;
  final double radius;
  final EdgeInsetsGeometry padding;
  final VoidCallback? onTap;
  final Color? tint;
  final double blur;

  @override
  Widget build(BuildContext context) {
    final shape = BorderRadius.circular(radius);
    final card = ClipRRect(
      borderRadius: shape,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: shape,
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [
                (tint ?? Colors.white).withValues(alpha: 0.16),
                (tint ?? Colors.white).withValues(alpha: 0.05),
              ],
            ),
            border: Border.all(color: Colors.white.withValues(alpha: 0.22)),
          ),
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              onTap: onTap,
              borderRadius: shape,
              child: Padding(padding: padding, child: child),
            ),
          ),
        ),
      ),
    );
    return onTap == null ? card : Pressable(child: card);
  }
}

class PrimaryButton extends StatelessWidget {
  const PrimaryButton({super.key, required this.label, required this.onPressed, this.icon, this.loading = false});
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool loading;
  @override
  Widget build(BuildContext context) => Pressable(
    enabled: onPressed != null && !loading,
    child: SizedBox(
    width: double.infinity,
    child: FilledButton(
      onPressed: loading ? null : onPressed,
      style: FilledButton.styleFrom(
        backgroundColor: lime,
        foregroundColor: ink,
        disabledBackgroundColor: lime.withValues(alpha: 0.35),
        minimumSize: const Size(0, 56),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        textStyle: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
      ),
      child: loading
          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: ink))
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[Icon(icon, size: 20), const SizedBox(width: 8)],
                Text(label),
              ],
            ),
    ),
  ),
  );
}

class GlassButton extends StatelessWidget {
  const GlassButton({super.key, required this.label, required this.onPressed, this.icon});
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  @override
  Widget build(BuildContext context) => Glass(
    radius: 18,
    padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 18),
    onTap: onPressed,
    child: Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        if (icon != null) ...[Icon(icon, size: 20), const SizedBox(width: 8)],
        Text(label, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
      ],
    ),
  );
}

class Eyebrow extends StatelessWidget {
  const Eyebrow(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Text(
    text.toUpperCase(),
    style: const TextStyle(color: lime, fontSize: 11, letterSpacing: 1.6, fontWeight: FontWeight.w800),
  );
}

class Logo extends StatelessWidget {
  const Logo({super.key, this.size = 32, this.word = true});
  final double size;
  final bool word;
  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: lime, borderRadius: BorderRadius.circular(size * 0.3)),
        child: Icon(Icons.bolt_rounded, color: ink, size: size * 0.72),
      ),
      if (word) ...[
        SizedBox(width: size * 0.3),
        Text('Zapnivo', style: TextStyle(fontSize: size * 0.72, fontWeight: FontWeight.w900, letterSpacing: -0.6)),
      ],
    ],
  );
}

class StateCard extends StatelessWidget {
  const StateCard({super.key, required this.icon, required this.title, required this.body, this.action});
  final IconData icon;
  final String title;
  final String body;
  final Widget? action;
  @override
  Widget build(BuildContext context) => Glass(
    child: SizedBox(
      width: double.infinity,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: lime, size: 32),
          const SizedBox(height: 14),
          Text(title, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
          const SizedBox(height: 6),
          Text(body, style: const TextStyle(color: muted, height: 1.45)),
          if (action != null) ...[const SizedBox(height: 12), action!],
        ],
      ),
    ),
  );
}

class ErrorText extends StatelessWidget {
  const ErrorText(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Text(text, style: const TextStyle(color: danger, fontWeight: FontWeight.w700)),
  );
}

class ScreenHeader extends StatelessWidget {
  const ScreenHeader({super.key, required this.title, this.eyebrow, this.trailing});
  final String title;
  final String? eyebrow;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Row(
    children: [
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (eyebrow != null) ...[Eyebrow(eyebrow!), const SizedBox(height: 6)],
            Text(title, style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w900, letterSpacing: -1)),
          ],
        ),
      ),
      ?trailing,
    ],
  );
}

class Dot extends StatelessWidget {
  const Dot({super.key, required this.color});
  final Color color;
  @override
  Widget build(BuildContext context) =>
      Container(width: 9, height: 9, decoration: BoxDecoration(shape: BoxShape.circle, color: color));
}

class NavItem {
  const NavItem(this.icon, this.selectedIcon, this.label);
  final IconData icon;
  final IconData selectedIcon;
  final String label;
}

class GlassNavBar extends StatelessWidget {
  const GlassNavBar({super.key, required this.items, required this.index, required this.onSelect});
  final List<NavItem> items;
  final int index;
  final ValueChanged<int> onSelect;
  @override
  Widget build(BuildContext context) => SafeArea(
    minimum: const EdgeInsets.fromLTRB(14, 0, 14, 10),
    child: Glass(
      radius: 30,
      blur: 28,
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
      child: Row(
        children: [
          for (var i = 0; i < items.length; i++)
            Expanded(
              child: InkResponse(
                onTap: () => onSelect(i),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 220),
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  decoration: BoxDecoration(
                    color: i == index ? lime.withValues(alpha: 0.2) : Colors.transparent,
                    borderRadius: BorderRadius.circular(22),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(i == index ? items[i].selectedIcon : items[i].icon, color: i == index ? lime : muted, size: 24),
                      const SizedBox(height: 2),
                      Text(
                        items[i].label,
                        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: i == index ? lime : muted),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    ),
  );
}

String money(int cents) => '\$${(cents / 100).toStringAsFixed(2)}';

String formatDuration(Duration d) {
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(d.inHours)}:${two(d.inMinutes % 60)}:${two(d.inSeconds % 60)}';
}

String formatDate(DateTime d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${months[d.month - 1]} ${d.day}, ${d.year}';
}

String formatTime(DateTime d) {
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour >= 12 ? 'PM' : 'AM'}';
}
