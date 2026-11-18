import 'package:home_widget/home_widget.dart';

/// Pushes the latest wallet balance + rental status to the Android home-screen
/// widget. Widgets are native views — they only ever see what the app last
/// synced, never a live stream. All failures are swallowed: a widget update
/// must never break the flow that produced the data.
Future<void> syncHomeWidget({String? balance, String? rental}) async {
  try {
    if (balance != null) await HomeWidget.saveWidgetData<String>('balance', balance);
    if (rental != null) await HomeWidget.saveWidgetData<String>('rental', rental);
    await HomeWidget.updateWidget(qualifiedAndroidName: 'com.zapnivo.charging.ZapnivoWidgetProvider');
  } catch (_) {}
}
