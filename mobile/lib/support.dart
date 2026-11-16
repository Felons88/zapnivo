import 'package:flutter/material.dart';

import 'animations.dart';
import 'api.dart';
import 'app_state.dart';
import 'theme.dart';
import 'widgets.dart';

const _fallbackCategories = [
  'Charger did not dispense', 'Return not recognized', 'Billing question', 'Damaged charger', 'Refund request', 'Accessibility assistance', 'Other',
];

const _topics = [
  (Icons.power_off_outlined, 'Charger did not dispense', 'Paid but no power bank came out'),
  (Icons.keyboard_return_rounded, 'Return not recognized', "The station didn't confirm my return"),
  (Icons.receipt_long_outlined, 'Billing question', 'A charge looks wrong'),
  (Icons.broken_image_outlined, 'Damaged charger', 'Report a damaged or unsafe unit'),
  (Icons.currency_exchange_rounded, 'Refund request', 'Ask for money back'),
  (Icons.chat_bubble_outline_rounded, 'Other', 'Anything else'),
];

void _push(BuildContext c, Widget w) => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => w));

class SupportTab extends StatelessWidget {
  const SupportTab({super.key});
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final open = (app.tickets ?? const <TicketSummary>[]).where((t) => t.isOpen).toList();
    final waiting = open.where((t) => t.state == 'pending_customer').length;
    return RefreshIndicator(
      onRefresh: app.refreshTickets,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 130),
        children: stagger([
          const BigTitle('Support', padding: EdgeInsets.fromLTRB(0, 14, 0, 6)),
          const Text('Real people, right in the app.', style: TextStyle(color: muted, fontSize: 16)),
          const SizedBox(height: 18),
          SettingsRow(
            icon: Icons.forum_outlined,
            label: 'My requests',
            subtitle: app.tickets == null ? 'Loading…' : open.isEmpty ? 'No open requests' : '${open.length} open${waiting > 0 ? ' · $waiting need your reply' : ''}',
            trailing: waiting > 0 ? Container(padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4), decoration: BoxDecoration(color: lime, borderRadius: BorderRadius.circular(20)), child: Text('$waiting', style: const TextStyle(color: ink, fontWeight: FontWeight.w900))) : const Icon(Icons.chevron_right_rounded, color: muted, size: 26),
            onTap: () => _push(context, const TicketsScreen()),
          ),
          SettingsRow(icon: Icons.menu_book_outlined, label: 'How Zapnivo works', subtitle: 'Renting, paying and returning', onTap: () => _push(context, const HowItWorksScreen())),
          const SectionLabel('GET HELP WITH'),
          for (final t in _topics)
            SettingsRow(icon: t.$1, label: t.$2, subtitle: t.$3, onTap: () => _push(context, NewTicketScreen(category: t.$2))),
          const SizedBox(height: 26),
          const Text('Replies arrive here and as a notification. You never need to leave the app.', style: TextStyle(color: muted, fontSize: 13, height: 1.4)),
        ]),
      ),
    );
  }
}

class HowItWorksScreen extends StatelessWidget {
  const HowItWorksScreen({super.key});
  @override
  Widget build(BuildContext context) {
    const steps = [
      ('Find a station', 'Open the Map tab. Nearby stations are listed first with live availability.'),
      ('Scan to rent', 'Scan the QR on the station (or type its ID), review the price, then pay securely.'),
      ('Take your charger', 'The station dispenses your power bank. Your rental starts when it confirms.'),
      ('Return anywhere live', 'Push the bank into any live Zapnivo station. The station confirms the return and your receipt appears here.'),
      ('Stay on time', 'Return before the deadline shown on your active rental to avoid the non-return fee.'),
    ];
    return TitledPage(
      title: 'How it works',
      children: [
        for (var i = 0; i < steps.length; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: 22),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CircleAvatar(radius: 17, backgroundColor: lime, child: Text('${i + 1}', style: const TextStyle(color: ink, fontWeight: FontWeight.w900))),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [Text(steps[i].$1, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)), const SizedBox(height: 4), Text(steps[i].$2, style: const TextStyle(color: muted, height: 1.45))],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

Color _stateColor(String s) => switch (s) {
  'pending_customer' => lime,
  'resolved' || 'closed' => muted,
  _ => Colors.white,
};

class TicketsScreen extends StatelessWidget {
  const TicketsScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final tickets = app.tickets;
    return TitledPage(
      title: 'My requests',
      onRefresh: app.refreshTickets,
      children: [
        if (tickets == null && app.ticketsError != null)
          StateCard(icon: Icons.wifi_off, title: 'Could not load requests', body: app.ticketsError!, action: TextButton(onPressed: app.refreshTickets, child: const Text('Try again')))
        else if (tickets == null)
          const SkeletonList()
        else if (tickets.isEmpty)
          EmptyState(icon: Icons.inbox_outlined, title: 'No requests yet', body: 'When you contact support, the conversation lives here.', action: TextButton(onPressed: () => _push(context, const NewTicketScreen()), child: const Text('Contact support')))
        else
          for (final t in tickets)
            SettingsRow(
              icon: t.isOpen ? Icons.chat_bubble_outline_rounded : Icons.check_circle_outline_rounded,
              label: t.category.isEmpty ? t.subject : t.category,
              subtitle: '${t.number}${t.createdAt != null ? ' · ${formatDate(t.createdAt!)}' : ''}',
              trailing: Text(t.stateLabel, style: TextStyle(color: _stateColor(t.state), fontWeight: FontWeight.w700, fontSize: 13)),
              onTap: () => _push(context, TicketThreadScreen(number: t.number)),
            ),
        Padding(padding: const EdgeInsets.only(top: 24), child: PrimaryButton(label: 'New request', icon: Icons.add, onPressed: () => _push(context, const NewTicketScreen()))),
      ],
    );
  }
}

class NewTicketScreen extends StatefulWidget {
  const NewTicketScreen({super.key, this.category, this.rentalRef});
  final String? category;
  final String? rentalRef;
  @override
  State<NewTicketScreen> createState() => _NewTicketScreenState();
}

class _NewTicketScreenState extends State<NewTicketScreen> {
  final form = GlobalKey<FormState>();
  final text = TextEditingController();
  String? category;
  String? rentalRef;
  bool sending = false;
  String? error;

  @override
  void initState() {
    super.initState();
    category = widget.category;
    rentalRef = widget.rentalRef;
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (!form.currentState!.validate() || sending) return;
    final app = AppScope.of(context);
    final nav = Navigator.of(context);
    setState(() {
      sending = true;
      error = null;
    });
    try {
      final number = await app.api.createTicket(category: category!, description: text.text, rentalRef: rentalRef);
      app.refreshTickets();
      if (!mounted) return;
      nav.pushReplacement(MaterialPageRoute<void>(builder: (_) => TicketSentScreen(number: number)));
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final categories = app.ticketCategories.isEmpty ? _fallbackCategories : app.ticketCategories;
    final rentals = app.rentals ?? const <Rental>[];
    return Scaffold(
      appBar: AppBar(title: const Text('Contact support')),
      body: Form(
        key: form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
          children: [
            const Text('Tell us what happened', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: -0.8)),
            const SizedBox(height: 6),
            const Text('We usually reply within a few hours. You will get a notification here.', style: TextStyle(color: muted, height: 1.4)),
            const SizedBox(height: 22),
            DropdownButtonFormField<String>(
              initialValue: categories.contains(category) ? category : null,
              dropdownColor: inkSoft,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Topic'),
              items: [for (final c in categories) DropdownMenuItem(value: c, child: Text(c))],
              onChanged: (v) => setState(() => category = v),
              validator: (v) => v == null ? 'Choose a topic' : null,
            ),
            const SizedBox(height: 14),
            if (rentals.isNotEmpty)
              DropdownButtonFormField<String?>(
                initialValue: rentals.any((r) => r.reference == rentalRef) ? rentalRef : null,
                dropdownColor: inkSoft,
                isExpanded: true,
                decoration: const InputDecoration(labelText: 'Related rental (optional)'),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('None')),
                  for (final r in rentals.take(15)) DropdownMenuItem<String?>(value: r.reference, child: Text('${r.reference} · ${r.venue}', overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (v) => setState(() => rentalRef = v),
              ),
            const SizedBox(height: 14),
            TextFormField(
              controller: text,
              minLines: 5,
              maxLines: 9,
              maxLength: 4000,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(labelText: 'What went wrong?', alignLabelWithHint: true),
              validator: (v) => v == null || v.trim().length < 10 ? 'Add a little more detail (10+ characters)' : null,
            ),
            const Text('Never include card numbers. We never need them.', style: TextStyle(color: muted, fontSize: 12)),
            if (error != null) ErrorText(error!),
            const SizedBox(height: 22),
            PrimaryButton(label: 'Send request', loading: sending, onPressed: submit),
          ],
        ),
      ),
    );
  }
}

class TicketSentScreen extends StatelessWidget {
  const TicketSentScreen({super.key, required this.number});
  final String number;
  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          children: [
            const Spacer(),
            const AnimatedCheckmark(),
            const SizedBox(height: 10),
            FadeSlideIn(delay: const Duration(milliseconds: 900), child: const Text('Request sent', style: TextStyle(fontSize: 30, fontWeight: FontWeight.w900, letterSpacing: -0.8))),
            const SizedBox(height: 8),
            FadeSlideIn(delay: const Duration(milliseconds: 1000), child: Text('Reference $number. We will reply right here.', textAlign: TextAlign.center, style: const TextStyle(color: muted, height: 1.4))),
            const Spacer(),
            FadeSlideIn(delay: const Duration(milliseconds: 1100), child: PrimaryButton(label: 'View conversation', onPressed: () => Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => TicketThreadScreen(number: number))))),
            TextButton(onPressed: () => Navigator.of(context).popUntil((r) => r.isFirst), child: const Text('Done', style: TextStyle(color: muted))),
          ],
        ),
      ),
    ),
  );
}

class TicketThreadScreen extends StatefulWidget {
  const TicketThreadScreen({super.key, required this.number});
  final String number;
  @override
  State<TicketThreadScreen> createState() => _TicketThreadScreenState();
}

class _TicketThreadScreenState extends State<TicketThreadScreen> {
  final reply = TextEditingController();
  final scroll = ScrollController();
  TicketThread? thread;
  String? error;
  bool sending = false;
  AppState? app;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (app == null) {
      app = AppScope.of(context)..ticketTick.addListener(load);
      load();
    }
  }

  @override
  void dispose() {
    app?.ticketTick.removeListener(load);
    reply.dispose();
    scroll.dispose();
    super.dispose();
  }

  Future<void> load() async {
    try {
      final t = await app!.api.ticketThread(widget.number);
      if (mounted) {
        setState(() {
          thread = t;
          error = null;
        });
        _toEnd();
      }
    } on ApiException catch (e) {
      if (mounted && thread == null) setState(() => error = e.message);
    }
  }

  void _toEnd() => WidgetsBinding.instance.addPostFrameCallback((_) {
    if (scroll.hasClients) scroll.animateTo(scroll.position.maxScrollExtent, duration: const Duration(milliseconds: 250), curve: Curves.easeOut);
  });

  Future<void> act(String action, {String? body}) async {
    if (sending) return;
    setState(() {
      sending = true;
      error = null;
    });
    try {
      final t = await app!.api.ticketAction(widget.number, action, body: body);
      if (action == 'reply') reply.clear();
      app!.refreshTickets();
      if (mounted) setState(() => thread = t);
      _toEnd();
    } on ApiException catch (e) {
      if (mounted) setState(() => error = e.message);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = thread;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.number),
        actions: [
          if (t != null && t.isOpen)
            PopupMenuButton<String>(
              color: inkSoft,
              onSelected: (v) => act(v),
              itemBuilder: (_) => [
                if (!t.withPerson) const PopupMenuItem(value: 'human', child: Text('Talk to a person')),
                const PopupMenuItem(value: 'resolve', child: Text('Mark as resolved')),
              ],
            ),
        ],
      ),
      body: t == null
          ? Center(child: error != null ? Padding(padding: const EdgeInsets.all(24), child: StateCard(icon: Icons.error_outline, title: 'Could not open request', body: error!)) : const CircularProgressIndicator(color: lime))
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 4, 24, 12),
                  child: Row(
                    children: [
                      Expanded(child: Text(t.category.isEmpty ? t.subject : t.category, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800))),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                        decoration: BoxDecoration(color: Colors.white10, borderRadius: BorderRadius.circular(20)),
                        child: Text(t.isOpen ? (t.withPerson ? 'With our team' : 'Open') : 'Resolved', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: t.isOpen ? lime : muted)),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView(
                    controller: scroll,
                    padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                    children: [for (final m in t.messages) _Bubble(m)],
                  ),
                ),
                if (error != null) Padding(padding: const EdgeInsets.symmetric(horizontal: 24), child: ErrorText(error!)),
                if (t.isOpen)
                  SafeArea(
                    top: false,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Expanded(
                            child: TextField(controller: reply, minLines: 1, maxLines: 5, maxLength: 2000, textCapitalization: TextCapitalization.sentences, decoration: const InputDecoration(hintText: 'Write a message', counterText: '')),
                          ),
                          const SizedBox(width: 10),
                          IconButton.filled(
                            onPressed: sending ? null : () => reply.text.trim().isEmpty ? null : act('reply', body: reply.text),
                            style: IconButton.styleFrom(backgroundColor: lime, foregroundColor: ink, minimumSize: const Size(52, 52)),
                            icon: sending ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: ink)) : const Icon(Icons.arrow_upward_rounded),
                          ),
                        ],
                      ),
                    ),
                  )
                else
                  const Padding(padding: EdgeInsets.fromLTRB(24, 8, 24, 24), child: Text('This request is resolved. Start a new one if you still need help.', textAlign: TextAlign.center, style: TextStyle(color: muted))),
              ],
            ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble(this.m);
  final TicketMessage m;
  @override
  Widget build(BuildContext context) {
    final mine = m.mine;
    return FadeSlideIn(
      offset: 10,
      child: Align(
        alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 5),
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.78),
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 11),
          decoration: BoxDecoration(
            color: mine ? lime : Colors.white.withValues(alpha: 0.1),
            borderRadius: BorderRadius.only(topLeft: const Radius.circular(20), topRight: const Radius.circular(20), bottomLeft: Radius.circular(mine ? 20 : 5), bottomRight: Radius.circular(mine ? 5 : 20)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!mine) Padding(padding: const EdgeInsets.only(bottom: 3), child: Text(m.authorType == 'ai' ? 'Zapnivo assistant' : m.author, style: const TextStyle(color: lime, fontSize: 12, fontWeight: FontWeight.w800))),
              Text(m.body, style: TextStyle(color: mine ? ink : Colors.white, height: 1.4)),
              if (m.createdAt != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(formatTime(m.createdAt!), style: TextStyle(color: mine ? ink.withValues(alpha: 0.6) : muted, fontSize: 11))),
            ],
          ),
        ),
      ),
    );
  }
}
