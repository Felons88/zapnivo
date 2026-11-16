import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'auth.dart';
import 'theme.dart';

enum _Mode { login, signup, phone, reset }

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.auth, required this.phoneSignInAvailable, this.startOnSignUp = false});
  final MobileAuth auth;
  final bool phoneSignInAvailable;
  final bool startOnSignUp;
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final form = GlobalKey<FormState>();
  final name = TextEditingController();
  final email = TextEditingController();
  final password = TextEditingController();
  final phone = TextEditingController();
  final code = TextEditingController();
  late _Mode mode = widget.startOnSignUp ? _Mode.signup : _Mode.login;
  bool codeSent = false;
  bool busy = false;
  bool obscure = true;
  String? error;
  String? notice;

  @override
  void dispose() {
    for (final c in [name, email, password, phone, code]) {
      c.dispose();
    }
    super.dispose();
  }

  void go(_Mode next) => setState(() {
    mode = next;
    error = null;
    notice = null;
    codeSent = false;
  });

  Future<void> act(Future<void> Function() task) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
      notice = null;
    });
    try {
      await task();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } catch (_) {
      if (mounted) setState(() => error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> submit() => act(() async {
    if (!form.currentState!.validate()) return;
    switch (mode) {
      case _Mode.login:
        await widget.auth.signInWithEmail(email.text, password.text);
      case _Mode.signup:
        final signedIn = await widget.auth.signUpWithEmail(name.text, email.text, password.text);
        if (!signedIn && mounted) {
          setState(() => notice = 'Check ${email.text.trim()} to confirm your account, then log in.');
          mode = _Mode.login;
        }
      case _Mode.reset:
        await widget.auth.resetPassword(email.text);
        if (mounted) setState(() => notice = 'If that email has an account, a reset link is on its way.');
      case _Mode.phone:
        if (!codeSent) {
          await widget.auth.sendPhoneCode(phone.text);
          if (mounted) setState(() => codeSent = true);
        } else {
          await widget.auth.verifyPhoneCode(phone.text, code.text);
        }
    }
  });

  String? _required(String? v, String msg) => v == null || v.trim().isEmpty ? msg : null;
  String? _email(String? v) =>
      v != null && RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(v.trim()) ? null : 'Enter a valid email address';

  String get title => switch (mode) {
    _Mode.login => 'Log In',
    _Mode.signup => 'Create Your Account',
    _Mode.phone => 'Continue with phone',
    _Mode.reset => 'Reset password',
  };

  String get subtitle => switch (mode) {
    _Mode.login => 'Welcome back to Zapnivo.',
    _Mode.signup => 'Sign up to rent portable chargers and stay powered.',
    _Mode.phone => codeSent ? 'Code sent to ${phone.text}' : 'We will text you a six-digit code.',
    _Mode.reset => 'Enter your email and we will send a reset link.',
  };

  String get action => switch (mode) {
    _Mode.login => 'Log In',
    _Mode.signup => 'Sign Up',
    _Mode.reset => 'Send reset link',
    _Mode.phone => codeSent ? 'Verify and sign in' : 'Text me a code',
  };

  Widget _social() => Column(
    children: [
      GlassButton(
        label: 'Continue with Apple',
        icon: Icons.apple,
        onPressed: busy ? null : () => act(widget.auth.signInWithApple),
      ),
      const SizedBox(height: 10),
      GlassButton(
        label: 'Continue with Google',
        icon: Icons.g_mobiledata_rounded,
        onPressed: busy ? null : () => act(widget.auth.signInWithGoogle),
      ),
      if (widget.phoneSignInAvailable) ...[
        const SizedBox(height: 10),
        GlassButton(label: 'Continue with phone', icon: Icons.sms_outlined, onPressed: busy ? null : () => go(_Mode.phone)),
      ],
    ],
  );

  @override
  Widget build(BuildContext context) {
    final emailMode = mode == _Mode.login || mode == _Mode.signup;
    return Scaffold(
      appBar: mode == _Mode.reset || mode == _Mode.phone
          ? AppBar(leading: BackButton(onPressed: () => go(_Mode.login)))
          : null,
      body: SafeArea(
        child: Form(
          key: form,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 20, 24, 32),
            children: [
              const Center(child: Logo(size: 44, word: false)),
              const SizedBox(height: 22),
              Text(title, textAlign: TextAlign.center, style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900, letterSpacing: -0.8)),
              const SizedBox(height: 6),
              Text(subtitle, textAlign: TextAlign.center, style: const TextStyle(color: muted, height: 1.4)),
              const SizedBox(height: 24),
              Glass(
                padding: const EdgeInsets.all(18),
                child: Column(
                  children: [
                    if (mode == _Mode.signup) ...[
                      TextFormField(
                        controller: name,
                        textCapitalization: TextCapitalization.words,
                        autofillHints: const [AutofillHints.name],
                        decoration: const InputDecoration(labelText: 'Full name', prefixIcon: Icon(Icons.person_outline)),
                        validator: (v) => _required(v, 'Enter your name'),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (mode != _Mode.phone)
                      TextFormField(
                        controller: email,
                        keyboardType: TextInputType.emailAddress,
                        autofillHints: const [AutofillHints.email],
                        decoration: const InputDecoration(labelText: 'Email', prefixIcon: Icon(Icons.mail_outline)),
                        validator: _email,
                      ),
                    if (emailMode) ...[
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: password,
                        obscureText: obscure,
                        autofillHints: [mode == _Mode.signup ? AutofillHints.newPassword : AutofillHints.password],
                        decoration: InputDecoration(
                          labelText: 'Password',
                          prefixIcon: const Icon(Icons.lock_outline),
                          suffixIcon: IconButton(
                            onPressed: () => setState(() => obscure = !obscure),
                            icon: Icon(obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                          ),
                        ),
                        validator: (v) => v == null || v.length < (mode == _Mode.signup ? 8 : 1)
                            ? (mode == _Mode.signup ? 'Use at least 8 characters' : 'Enter your password')
                            : null,
                      ),
                    ],
                    if (mode == _Mode.phone) ...[
                      TextFormField(
                        controller: phone,
                        enabled: !codeSent,
                        keyboardType: TextInputType.phone,
                        autofillHints: const [AutofillHints.telephoneNumber],
                        decoration: const InputDecoration(labelText: 'Mobile number', hintText: '+1 555 555 1234'),
                        validator: (v) => _required(v, 'Enter your mobile number'),
                      ),
                      if (codeSent) ...[
                        const SizedBox(height: 12),
                        TextFormField(
                          controller: code,
                          autofocus: true,
                          keyboardType: TextInputType.number,
                          textAlign: TextAlign.center,
                          maxLength: 6,
                          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                          autofillHints: const [AutofillHints.oneTimeCode],
                          style: const TextStyle(fontSize: 24, letterSpacing: 8, fontWeight: FontWeight.w800),
                          decoration: const InputDecoration(labelText: 'Six-digit code', counterText: ''),
                          validator: (v) => v != null && v.length == 6 ? null : 'Enter the six-digit code',
                        ),
                      ],
                    ],
                    if (mode == _Mode.login)
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton(onPressed: () => go(_Mode.reset), child: const Text('Forgot Password?')),
                      ),
                    const SizedBox(height: 8),
                    PrimaryButton(label: action, onPressed: submit, loading: busy),
                  ],
                ),
              ),
              if (notice != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(notice!, style: const TextStyle(color: lime, fontWeight: FontWeight.w700)),
                ),
              if (error != null) ErrorText(error!),
              if (emailMode) ...[
                const SizedBox(height: 20),
                const Row(
                  children: [
                    Expanded(child: Divider(color: Colors.white24)),
                    Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: Text('or sign up with', style: TextStyle(color: muted, fontSize: 12))),
                    Expanded(child: Divider(color: Colors.white24)),
                  ],
                ),
                const SizedBox(height: 16),
                _social(),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(mode == _Mode.login ? "Don't have an account? " : 'Already have an account? ', style: const TextStyle(color: muted)),
                    GestureDetector(
                      onTap: () => go(mode == _Mode.login ? _Mode.signup : _Mode.login),
                      child: Text(mode == _Mode.login ? 'Sign Up' : 'Log in', style: const TextStyle(color: lime, fontWeight: FontWeight.w800)),
                    ),
                  ],
                ),
              ],
              if (mode == _Mode.phone && codeSent)
                TextButton(
                  onPressed: busy ? null : () => setState(() {
                    codeSent = false;
                    code.clear();
                  }),
                  child: const Text('Change number or request another code'),
                ),
              const SizedBox(height: 18),
              const Text(
                'No charge starts until you review the rental terms and pay.',
                textAlign: TextAlign.center,
                style: TextStyle(color: muted, fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
