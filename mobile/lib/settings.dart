import 'package:flutter/material.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'animations.dart';
import 'api.dart';
import 'app_state.dart';
import 'support.dart';
import 'tabs.dart';
import 'theme.dart';
import 'widgets.dart';

void _push(BuildContext c, Widget w) => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => w));

class _Version extends StatelessWidget {
  const _Version();
  @override
  Widget build(BuildContext context) => FutureBuilder<PackageInfo>(
    future: PackageInfo.fromPlatform(),
    builder: (_, s) => Padding(
      padding: const EdgeInsets.only(top: 28),
      child: Text(s.hasData ? 'Version ${s.data!.version} (${s.data!.buildNumber})' : '', style: const TextStyle(color: muted, fontSize: 13)),
    ),
  );
}

Future<void> _confirmLogout(BuildContext context) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: const Text('Log out?'),
      content: const Text('You will need to sign in again to rent a charger.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(c, true), style: FilledButton.styleFrom(backgroundColor: lime, foregroundColor: ink), child: const Text('Log out')),
      ],
    ),
  );
  if (ok == true) {
    if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
    await Supabase.instance.client.auth.signOut();
  }
}

class ProfileTab extends StatelessWidget {
  const ProfileTab({super.key});
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final user = Supabase.instance.client.auth.currentUser;
    final name = app.firstName;
    final fullName = (app.profile?['name'] as String?)?.trim();
    final email = app.profile?['email'] as String? ?? (user?.email != null && !user!.email!.endsWith('@mobile.zapnivo.com') ? user.email : null);
    final phone = app.profile?['phone'] as String?;
    final display = fullName != null && fullName.isNotEmpty ? fullName : (name.isEmpty ? 'Zapnivo renter' : name);
    final openTickets = (app.tickets ?? const <TicketSummary>[]).where((t) => t.isOpen).length;
    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 130),
      children: stagger([
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(child: Text(display, style: const TextStyle(fontSize: 34, fontWeight: FontWeight.w800, letterSpacing: -1))),
            CircleAvatar(radius: 34, backgroundColor: lime, child: Text(display[0].toUpperCase(), style: const TextStyle(color: ink, fontSize: 30, fontWeight: FontWeight.w900))),
          ],
        ),
        if (email != null || phone != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(email ?? phone!, style: const TextStyle(color: muted, fontSize: 15))),
        const SizedBox(height: 22),
        Row(
          children: [
            Expanded(child: _tile(Icons.timer_outlined, 'Rentals', () => app.setTab(2))),
            const SizedBox(width: 12),
            Expanded(child: _tile(Icons.support_agent_rounded, 'Help', () => app.setTab(3), badge: openTickets)),
            const SizedBox(width: 12),
            Expanded(child: _tile(Icons.account_balance_wallet_outlined, 'Payments', () => _push(context, const PaymentsScreen()))),
          ],
        ),
        const SizedBox(height: 18),
        SettingsRow(icon: Icons.settings_outlined, label: 'Account settings', onTap: () => _push(context, const AccountSettingsScreen())),
        SettingsRow(icon: Icons.history_rounded, label: 'Rental history', onTap: () => _push(context, const HistoryScreen())),
        SettingsRow(icon: Icons.notifications_none_rounded, label: 'Notifications', onTap: () => _push(context, const NotificationsScreen())),
        SettingsRow(icon: Icons.info_outline_rounded, label: 'About Zapnivo', onTap: () => _push(context, const AboutScreen())),
        SettingsRow(icon: Icons.logout_rounded, label: 'Log out', color: danger, divider: false, onTap: () => _confirmLogout(context)),
        const Center(child: _Version()),
      ]),
    );
  }

  Widget _tile(IconData icon, String label, VoidCallback tap, {int badge = 0}) => Glass(
    radius: 22,
    padding: const EdgeInsets.symmetric(vertical: 20),
    onTap: tap,
    child: Column(
      children: [
        Badge(isLabelVisible: badge > 0, label: Text('$badge'), backgroundColor: lime, textColor: ink, child: Icon(icon, size: 28)),
        const SizedBox(height: 10),
        Text(label, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
      ],
    ),
  );
}

class AccountSettingsScreen extends StatelessWidget {
  const AccountSettingsScreen({super.key});
  @override
  Widget build(BuildContext context) => TitledPage(
    title: 'Account settings',
    footer: const Padding(padding: EdgeInsets.symmetric(horizontal: 24), child: _Version()),
    children: [
      SettingsRow(icon: Icons.person_outline_rounded, label: 'Personal information', onTap: () => _push(context, const PersonalInfoScreen())),
      SettingsRow(icon: Icons.shield_outlined, label: 'Login & security', onTap: () => _push(context, const SecurityScreen())),
      SettingsRow(icon: Icons.pan_tool_outlined, label: 'Privacy', onTap: () => _push(context, const PrivacyScreen())),
      SettingsRow(icon: Icons.notifications_active_outlined, label: 'Notifications', onTap: () => _push(context, const NotificationSettingsScreen())),
      SettingsRow(icon: Icons.payments_outlined, label: 'Payments', onTap: () => _push(context, const PaymentsScreen())),
      SettingsRow(icon: Icons.receipt_long_outlined, label: 'Receipts & history', onTap: () => _push(context, const HistoryScreen())),
      SettingsRow(icon: Icons.support_agent_rounded, label: 'Help & support', divider: false, onTap: () {
        final app = AppScope.of(context);
        Navigator.of(context).popUntil((r) => r.isFirst);
        app.setTab(3);
      }),
    ],
  );
}

class PersonalInfoScreen extends StatefulWidget {
  const PersonalInfoScreen({super.key});
  @override
  State<PersonalInfoScreen> createState() => _PersonalInfoScreenState();
}

class _PersonalInfoScreenState extends State<PersonalInfoScreen> {
  final name = TextEditingController();
  bool saving = false;
  String? error;
  bool saved = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final app = AppScope.of(context);
      name.text = (app.profile?['name'] as String?) ?? '';
      app.refreshProfile().then((_) {
        if (mounted && name.text.isEmpty) name.text = (app.profile?['name'] as String?) ?? '';
      });
    });
  }

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> save() async {
    final app = AppScope.of(context);
    if (name.text.trim().isEmpty) {
      setState(() => error = 'Enter your name.');
      return;
    }
    setState(() {
      saving = true;
      error = null;
      saved = false;
    });
    try {
      await app.api.updateProfile(name: name.text.trim());
      await app.refreshProfile();
      if (mounted) setState(() => saved = true);
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final email = app.profile?['email'] as String?;
    final phone = app.profile?['phone'] as String?;
    return TitledPage(
      title: 'Personal information',
      children: [
        TextField(controller: name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Legal name')),
        const SizedBox(height: 14),
        _readonly('Email', email ?? 'Not set'),
        const SizedBox(height: 14),
        _readonly('Phone', phone ?? 'Not set'),
        const SizedBox(height: 8),
        const Text('Email and phone are tied to how you sign in. Contact support to change them.', style: TextStyle(color: muted, fontSize: 13, height: 1.4)),
        if (error != null) ErrorText(error!),
        if (saved) const Padding(padding: EdgeInsets.only(top: 12), child: Text('Saved.', style: TextStyle(color: lime, fontWeight: FontWeight.w800))),
        const SizedBox(height: 22),
        PrimaryButton(label: 'Save', loading: saving, onPressed: save),
        TextButton(onPressed: () => _push(context, const NewTicketScreen(category: 'Other')), child: const Text('Contact support to change email or phone')),
      ],
    );
  }

  Widget _readonly(String label, String value) => InputDecorator(
    decoration: InputDecoration(labelText: label, enabled: false),
    child: Text(value, style: const TextStyle(color: muted)),
  );
}

class SecurityScreen extends StatefulWidget {
  const SecurityScreen({super.key});
  @override
  State<SecurityScreen> createState() => _SecurityScreenState();
}

class _SecurityScreenState extends State<SecurityScreen> {
  final password = TextEditingController();
  bool busy = false;
  String? error;
  String? done;

  @override
  void dispose() {
    password.dispose();
    super.dispose();
  }

  Future<void> change() async {
    if (password.text.length < 8) {
      setState(() => error = 'Use at least 8 characters.');
      return;
    }
    setState(() {
      busy = true;
      error = null;
      done = null;
    });
    try {
      await Supabase.instance.client.auth.updateUser(UserAttributes(password: password.text));
      password.clear();
      if (mounted) setState(() => done = 'Password updated.');
    } on AuthException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final user = Supabase.instance.client.auth.currentUser;
    final provider = (user?.appMetadata['provider'] as String?) ?? 'email';
    final label = switch (provider) { 'google' => 'Google', 'apple' => 'Apple', 'phone' => 'Phone code', _ => 'Email and password' };
    return TitledPage(
      title: 'Login & security',
      children: [
        SettingsRow(icon: Icons.key_rounded, label: 'Sign-in method', subtitle: label),
        if (provider == 'email') ...[
          const SectionLabel('CHANGE PASSWORD'),
          const SizedBox(height: 10),
          TextField(controller: password, obscureText: true, decoration: const InputDecoration(labelText: 'New password')),
          if (error != null) ErrorText(error!),
          if (done != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(done!, style: const TextStyle(color: lime, fontWeight: FontWeight.w800))),
          const SizedBox(height: 16),
          PrimaryButton(label: 'Update password', loading: busy, onPressed: change),
        ],
        const SizedBox(height: 18),
        SettingsRow(icon: Icons.logout_rounded, label: 'Log out of this device', color: danger, divider: false, onTap: () => _confirmLogout(context)),
      ],
    );
  }
}

class PrivacyScreen extends StatefulWidget {
  const PrivacyScreen({super.key});
  @override
  State<PrivacyScreen> createState() => _PrivacyScreenState();
}

class _PrivacyScreenState extends State<PrivacyScreen> {
  bool deleting = false;

  Future<void> deleteAccount() async {
    final app = AppScope.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Delete your account?'),
        content: const Text('We remove your personal details and queue the deletion of your login. Rental and payment records are kept where the law requires. This cannot be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), style: FilledButton.styleFrom(backgroundColor: danger, foregroundColor: ink), child: const Text('Request deletion')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => deleting = true);
    try {
      await app.api.requestAccountDeletion();
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      await Supabase.instance.client.auth.signOut();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => deleting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return TitledPage(
      title: 'Privacy',
      children: [
        SettingsRow(
          icon: Icons.location_on_outlined,
          label: 'Location',
          subtitle: app.locationDenied ? 'Off. Turn on to see stations near you' : app.position != null ? 'On. Used only to find nearby stations' : 'Used only to find nearby stations',
          onTap: () async {
            await openAppSettings();
            app.locate();
          },
        ),
        SettingsRow(icon: Icons.description_outlined, label: 'Privacy policy', onTap: () => _push(context, const InAppPage(title: 'Privacy policy', url: '$siteBase/legal/privacy'))),
        SettingsRow(icon: Icons.gavel_rounded, label: 'Rental terms', onTap: () => _push(context, const InAppPage(title: 'Rental terms', url: '$siteBase/legal/rental-terms'))),
        SettingsRow(icon: Icons.delete_outline_rounded, label: deleting ? 'Sending request…' : 'Delete my account', color: danger, divider: false, onTap: deleting ? null : deleteAccount),
      ],
    );
  }
}

class NotificationSettingsScreen extends StatefulWidget {
  const NotificationSettingsScreen({super.key});
  @override
  State<NotificationSettingsScreen> createState() => _NotificationSettingsScreenState();
}

class _NotificationSettingsScreenState extends State<NotificationSettingsScreen> with WidgetsBindingObserver {
  bool? sms;
  String? error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) AppScope.of(context).refreshNotificationStatus();
  }

  Future<void> togglePush() async {
    final app = AppScope.of(context);
    final status = await Permission.notification.request();
    if (status.isPermanentlyDenied || status.isDenied && app.notificationStatus?.isDenied == true) await openAppSettings();
    await app.refreshNotificationStatus();
  }

  Future<void> toggleSms(bool v) async {
    final app = AppScope.of(context);
    setState(() {
      sms = v;
      error = null;
    });
    try {
      await app.api.updateProfile(notifySms: v);
      await app.refreshProfile();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          sms = !v;
          error = e.message;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final push = app.notificationStatus?.isGranted ?? false;
    final smsOn = sms ?? (app.profile?['notify_sms'] == true);
    return TitledPage(
      title: 'Notifications',
      children: [
        SettingsRow(
          icon: Icons.notifications_active_outlined,
          label: 'Push notifications',
          subtitle: push ? 'On: rental, return and support updates' : 'Off. Turn on for return reminders and replies',
          trailing: Switch(value: push, onChanged: (_) => togglePush(), activeThumbColor: ink, activeTrackColor: lime),
        ),
        SettingsRow(
          icon: Icons.sms_outlined,
          label: 'Text message updates',
          subtitle: 'Return reminders by SMS',
          trailing: Switch(value: smsOn, onChanged: toggleSms, activeThumbColor: ink, activeTrackColor: lime),
        ),
        if (error != null) ErrorText(error!),
        SettingsRow(icon: Icons.inbox_outlined, label: 'Notification inbox', divider: false, onTap: () => _push(context, const NotificationsScreen())),
      ],
    );
  }
}

class PaymentsScreen extends StatelessWidget {
  const PaymentsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final paid = (app.rentals ?? const <Rental>[]).where((r) => r.amountCents != null && r.amountCents! > 0);
    final total = paid.fold<int>(0, (a, r) => a + r.amountCents!);
    return TitledPage(
      title: 'Payments',
      children: [
        Glass(
          padding: const EdgeInsets.all(22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Eyebrow('Total spent'),
              const SizedBox(height: 8),
              CountUpMoney(cents: total, style: const TextStyle(fontSize: 42, fontWeight: FontWeight.w900, letterSpacing: -1.5)),
              Text('${paid.length} paid rental${paid.length == 1 ? '' : 's'}', style: const TextStyle(color: muted)),
            ],
          ),
        ),
        const SizedBox(height: 10),
        const SettingsRow(icon: Icons.lock_outline_rounded, label: 'Secure checkout', subtitle: 'Card, Apple Pay or Google Pay, handled by Stripe. We never see or store your card number.'),
        SettingsRow(icon: Icons.receipt_long_outlined, label: 'Receipts', subtitle: 'Every rental has an itemized receipt', divider: false, onTap: () => _push(context, const HistoryScreen())),
      ],
    );
  }
}

class AboutScreen extends StatefulWidget {
  const AboutScreen({super.key});
  @override
  State<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends State<AboutScreen> {
  String? note;
  bool checking = false;

  Future<void> check() async {
    final app = AppScope.of(context);
    setState(() {
      checking = true;
      note = null;
    });
    await app.updater.check();
    if (mounted) {
      setState(() {
        checking = false;
        note = app.updater.available == null ? 'You are on the latest version.' : 'Version ${app.updater.available!.version} is ready to install.';
      });
    }
  }

  @override
  Widget build(BuildContext context) => TitledPage(
    title: 'About Zapnivo',
    footer: const Padding(padding: EdgeInsets.symmetric(horizontal: 24), child: _Version()),
    children: [
      _UpdateBox(checking: checking, note: note, onCheck: check),
      SettingsRow(icon: Icons.menu_book_outlined, label: 'How Zapnivo works', onTap: () => _push(context, const HowItWorksScreen())),
      SettingsRow(icon: Icons.description_outlined, label: 'Rental terms', onTap: () => _push(context, const InAppPage(title: 'Rental terms', url: '$siteBase/legal/rental-terms'))),
      SettingsRow(icon: Icons.privacy_tip_outlined, label: 'Privacy policy', divider: false, onTap: () => _push(context, const InAppPage(title: 'Privacy policy', url: '$siteBase/legal/privacy'))),
    ],
  );
}

/// The update card in About: celebrates a freshly installed OTA build, offers
/// a one-tap install when a newer build exists, and checks on tap otherwise.
/// Listens to the shared Updater so download progress streams in live.
class _UpdateBox extends StatelessWidget {
  const _UpdateBox({required this.checking, required this.note, required this.onCheck});
  final bool checking;
  final String? note;
  final VoidCallback onCheck;

  @override
  Widget build(BuildContext context) {
    final updater = AppScope.of(context).updater;
    return AnimatedBuilder(
      animation: updater,
      builder: (context, _) {
        // 1) Just-updated celebration — persists until dismissed.
        if (updater.justUpdated != null) {
          return Glass(
            tint: lime,
            radius: 20,
            child: Column(
              children: [
                FadeSlideIn(child: const AnimatedCheckmark(size: 40)),
                const SizedBox(height: 8),
                const Text('App updated', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                const SizedBox(height: 4),
                Text("You're now on version ${updater.justUpdated}", style: const TextStyle(color: Colors.white70, fontSize: 13)),
                const SizedBox(height: 10),
                GlassButton(label: 'Nice', onPressed: updater.clearJustUpdated),
              ],
            ),
          );
        }
        // 2) Update available — tappable install + live download progress.
        final u = updater.available;
        if (u != null) {
          final downloading = updater.progress != null;
          return Glass(
            tint: lime,
            radius: 20,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Icon(downloading ? Icons.downloading_rounded : Icons.system_update_alt_rounded, color: lime),
                  const SizedBox(width: 12),
                  Expanded(child: Text(downloading ? (updater.status ?? 'Updating…') : 'Version ${u.version} is ready to install', style: const TextStyle(fontWeight: FontWeight.w800))),
                ]),
                if (downloading)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: LinearProgressIndicator(value: updater.progress, color: lime, backgroundColor: Colors.white24, minHeight: 4),
                  )
                else ...[
                  if (u.notes.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(u.notes, style: const TextStyle(color: Colors.white70, fontSize: 13))),
                  const SizedBox(height: 10),
                  GlassButton(label: 'Update now', icon: Icons.system_update_alt_rounded, onPressed: updater.install),
                ],
              ],
            ),
          );
        }
        // 3) Idle — manual check.
        return SettingsRow(
          icon: Icons.system_update_alt_rounded,
          label: checking ? 'Checking…' : 'Check for updates',
          subtitle: updater.status ?? note ?? 'The app also checks automatically every 5 minutes',
          onTap: checking ? null : onCheck,
        );
      },
    );
  }
}
