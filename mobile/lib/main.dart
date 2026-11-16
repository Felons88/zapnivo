import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'api.dart';
import 'app_state.dart';
import 'auth.dart';
import 'onboarding.dart';
import 'services.dart';
import 'settings.dart';
import 'sign_in.dart';
import 'support.dart';
import 'stations.dart';
import 'tabs.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await PushService.init();
  runApp(const ZapnivoApp());
}

class ZapnivoApp extends StatefulWidget {
  const ZapnivoApp({super.key});
  @override
  State<ZapnivoApp> createState() => _ZapnivoAppState();
}

class _ZapnivoAppState extends State<ZapnivoApp> {
  final state = AppState();

  @override
  void dispose() {
    state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle.light);
    return MaterialApp(
      title: 'Zapnivo',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      builder: (context, child) => AppScope(state: state, child: AppBackdrop(child: child!)),
      home: const AppGate(),
    );
  }
}

class AppGate extends StatefulWidget {
  const AppGate({super.key});
  @override
  State<AppGate> createState() => _AppGateState();
}

class _AppGateState extends State<AppGate> {
  final auth = MobileAuth();
  String? failure;
  bool ready = false;
  bool onboarded = false;
  bool justOnboarded = false;
  bool permissionsDone = false;
  bool phoneSignInAvailable = false;

  @override
  void initState() {
    super.initState();
    bootstrap();
  }

  Future<void> bootstrap() async {
    setState(() {
      failure = null;
      ready = false;
    });
    try {
      final started = DateTime.now();
      final config = await auth.loadConfig();
      await auth.initialize(config);
      final prefs = await SharedPreferences.getInstance();
      final wait = const Duration(milliseconds: 1400) - DateTime.now().difference(started);
      if (!wait.isNegative) await Future<void>.delayed(wait);
      if (!mounted) return;
      setState(() {
        ready = true;
        onboarded = prefs.getBool('onboarding_seen') ?? false;
        permissionsDone = prefs.getBool('permissions_seen') ?? false;
        phoneSignInAvailable = config.phoneSignInAvailable;
      });
    } catch (e) {
      if (mounted) setState(() => failure = e is ApiException ? e.message : 'Sign-in could not start. Check your connection.');
    }
  }

  Future<void> _mark(String key) async => (await SharedPreferences.getInstance()).setBool(key, true);

  @override
  Widget build(BuildContext context) {
    if (failure != null) {
      return Scaffold(
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: StateCard(
                icon: Icons.wifi_off,
                title: 'Could not connect',
                body: failure!,
                action: TextButton(onPressed: bootstrap, child: const Text('Try again')),
              ),
            ),
          ),
        ),
      );
    }
    if (!ready) return const SplashScreen();
    return StreamBuilder<AuthState>(
      stream: auth.supabase.auth.onAuthStateChange,
      builder: (context, _) {
        if (auth.supabase.auth.currentSession == null) {
          if (!onboarded) {
            return OnboardingScreen(
              onComplete: () {
                _mark('onboarding_seen');
                setState(() {
                  onboarded = true;
                  justOnboarded = true;
                });
              },
            );
          }
          return SignInScreen(auth: auth, phoneSignInAvailable: phoneSignInAvailable, startOnSignUp: justOnboarded);
        }
        if (!permissionsDone) {
          return PermissionsFlow(
            onComplete: () {
              _mark('permissions_seen');
              setState(() => permissionsDone = true);
            },
          );
        }
        return const HomeShell();
      },
    );
  }
}

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});
  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  AppState? app;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    app ??= AppScope.of(context)..start();
  }

  @override
  void dispose() {
    app?.stop();
    super.dispose();
  }

  static const items = [
    NavItem(Icons.home_outlined, Icons.home_rounded, 'Home'),
    NavItem(Icons.map_outlined, Icons.map_rounded, 'Map'),
    NavItem(Icons.timer_outlined, Icons.timer_rounded, 'Rentals'),
    NavItem(Icons.support_agent_outlined, Icons.support_agent, 'Support'),
    NavItem(Icons.person_outline, Icons.person, 'Profile'),
  ];

  @override
  Widget build(BuildContext context) {
    final state = AppScope.of(context);
    return Scaffold(
      extendBody: true,
      body: Stack(
        children: [
          SafeArea(
            bottom: false,
            child: IndexedStack(
              index: state.tab,
              children: const [HomeTab(), MapTab(), RentalsTab(), SupportTab(), ProfileTab()],
            ),
          ),
          Positioned(left: 16, right: 16, top: 0, child: SafeArea(child: UpdateBanner(updater: state.updater))),
        ],
      ),
      bottomNavigationBar: GlassNavBar(items: items, index: state.tab, onSelect: state.setTab),
    );
  }
}

/// Slides in when a newer build is published to the app-releases bucket.
class UpdateBanner extends StatelessWidget {
  const UpdateBanner({super.key, required this.updater});
  final Updater updater;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: updater,
    builder: (context, _) {
      final u = updater.available;
      return AnimatedSwitcher(
        duration: const Duration(milliseconds: 350),
        transitionBuilder: (c, a) => SlideTransition(position: Tween(begin: const Offset(0, -1.2), end: Offset.zero).animate(CurvedAnimation(parent: a, curve: Curves.easeOutCubic)), child: FadeTransition(opacity: a, child: c)),
        child: u == null
            ? const SizedBox.shrink()
            : Padding(
                key: const ValueKey('update'),
                padding: const EdgeInsets.only(top: 8),
                child: Glass(
                  tint: lime,
                  radius: 22,
                  padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
                  child: Row(
                    children: [
                      const Icon(Icons.system_update_alt_rounded, color: lime),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(updater.progress != null ? (updater.status ?? 'Updating…') : 'Update ${u.version} available', style: const TextStyle(fontWeight: FontWeight.w800)),
                            if (updater.progress != null)
                              Padding(padding: const EdgeInsets.only(top: 6), child: LinearProgressIndicator(value: updater.progress, color: lime, backgroundColor: Colors.white24, minHeight: 4))
                            else if (u.notes.isNotEmpty)
                              Text(u.notes, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: muted, fontSize: 12)),
                          ],
                        ),
                      ),
                      if (updater.progress == null) ...[
                        FilledButton(onPressed: updater.install, style: FilledButton.styleFrom(backgroundColor: lime, foregroundColor: ink), child: const Text('Update')),
                        if (!u.mandatory) IconButton(onPressed: updater.dismiss, icon: const Icon(Icons.close, size: 20)),
                      ],
                    ],
                  ),
                ),
              ),
      );
    },
  );
}
