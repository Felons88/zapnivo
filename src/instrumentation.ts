import type { Instrumentation } from "next";
import { reportError } from "@/lib/observability";

/**
 * Server error capture — every unhandled route/render error lands in error_events
 * via reportError (fail-open; telemetry can never break a request).
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  try {
    const route = request.path ?? context.routePath ?? undefined;
    reportError(err, { route, severity: "error", attrs: { routerKind: context.routerKind, renderSource: context.renderSource } });
  } catch { /* fail-open */ }
};
