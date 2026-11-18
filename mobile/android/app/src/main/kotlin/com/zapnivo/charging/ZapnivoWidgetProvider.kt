package com.zapnivo.charging

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.widget.RemoteViews
import es.antonborri.home_widget.HomeWidgetLaunchIntent
import es.antonborri.home_widget.HomeWidgetProvider

/**
 * Home-screen widget: balance + rental status (pushed from Dart via
 * HomeWidget.saveWidgetData) and shortcuts into the app's scan/return/wallet
 * screens. Widgets are read-only RemoteViews — taps deep-link into
 * MainActivity, which the app handles via the widgetClicked stream.
 */
class ZapnivoWidgetProvider : HomeWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
        widgetData: SharedPreferences
    ) {
        val balance = widgetData.getString("balance", "—") ?: "—"
        val rental = widgetData.getString("rental", "No active rental") ?: "No active rental"
        for (id in appWidgetIds) {
            val views = RemoteViews(context.packageName, R.layout.zapnivo_widget)
            views.setTextViewText(R.id.widget_balance, balance)
            views.setTextViewText(R.id.widget_rental, rental)
            views.setOnClickPendingIntent(
                R.id.widget_rent,
                HomeWidgetLaunchIntent.getActivity(context, MainActivity::class.java, Uri.parse("zapnivowidget://rent"))
            )
            views.setOnClickPendingIntent(
                R.id.widget_return,
                HomeWidgetLaunchIntent.getActivity(context, MainActivity::class.java, Uri.parse("zapnivowidget://return"))
            )
            views.setOnClickPendingIntent(
                R.id.widget_wallet,
                HomeWidgetLaunchIntent.getActivity(context, MainActivity::class.java, Uri.parse("zapnivowidget://wallet"))
            )
            appWidgetManager.updateAppWidget(id, views)
        }
    }
}
