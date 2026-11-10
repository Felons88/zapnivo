import { fmt, PRICING_V1 } from "../pricing";

/**
 * Canned replies for agents. Wording follows the published rental terms and refund policy;
 * pricing is read from the pricing config. Variables: {{name}} {{ticket}} {{agent}}.
 * Macros never promise a refund. Money decisions go through the refund workflow.
 */
const P = PRICING_V1;
export type Macro = { id: string; title: string; audience: "customer" | "partner" | "both"; body: string };

export const MACROS: Macro[] = [
  { id: "ask-details", title: "Ask for rental details", audience: "customer", body: "Hi {{name}},\n\nThanks for contacting Zapnivo. To look into this, could you reply with:\n• Your rental reference (ZR-XXXXXXXX) from your receipt, or the date and approximate time\n• The station or venue name\n• A short description of what happened\n\nPlease don't send card numbers or passwords.\n\n{{agent}}\nZapnivo Support (ref {{ticket}})" },
  { id: "pricing", title: "Explain pricing", audience: "customer", body: `Hi {{name}},\n\nRentals are charged per started hour: ${fmt(P.firstHourCents)} for the first hour and ${fmt(P.additionalHourCents)} for each additional started hour, billed at ${fmt(P.additionalHourCents)} per started hour. Taxes are added at checkout. A temporary payment authorization may appear, but only the final rental charge is captured. These are proposed pilot rates, and the price shown at checkout is what applies.\n\n{{agent}}\nZapnivo Support (ref {{ticket}})` },
  { id: "nonreturn", title: "Explain non-return charge", audience: "customer", body: `Hi {{name}},\n\nIf a power bank isn't returned within ${P.nonReturnAfterHours} hours, the non-return maximum of ${fmt(P.nonReturnMaxCents)} may be charged and the rental closes; it does not transfer ownership. If you returned it, we'll verify against station records. Reply with the station and approximate return time.\n\n{{agent}}\nZapnivo Support (ref {{ticket}})` },
  { id: "investigating", title: "We're investigating", audience: "both", body: "Hi {{name}},\n\nThanks for the details. We're checking this against our station and payment records and will follow up by email as soon as we have an answer.\n\n{{agent}}\nZapnivo Support (ref {{ticket}})" },
  { id: "refund-issued", title: "Refund issued", audience: "customer", body: "Hi {{name}},\n\nWe've issued your refund to the original payment method. Banks post refunds on their own schedule, so it may take some time to appear on your statement. Thanks for your patience.\n\n{{agent}}\nZapnivo Support (ref {{ticket}})" },
  { id: "refund-declined", title: "Refund not approved", audience: "customer", body: "Hi {{name}},\n\nWe reviewed your request against station and payment records. Based on that review, we're not able to refund this charge: [REASON]. If you believe we've missed something, reply with any extra details and we'll look again. You also keep the right to dispute with your card issuer.\n\n{{agent}}\nZapnivo Support (ref {{ticket}})" },
  { id: "damaged", title: "Damaged power bank: safety", audience: "customer", body: "Hi {{name}},\n\nThank you for reporting this. Please stop using the power bank, don't try to open or repair it, and keep it away from flammable materials. If it is safe to do so, return it to an eligible station. Please reply with the station and a photo if you can.\n\n{{agent}}\nZapnivo Support (ref {{ticket}})" },
  { id: "partner-ack", title: "Partner: acknowledged", audience: "partner", body: "Hi {{name}},\n\nThanks for flagging this. Our partner team is on it and will update you here. Please don't move or open the station in the meantime.\n\n{{agent}}\nZapnivo Partner Support (ref {{ticket}})" },
  { id: "partner-guest", title: "Partner: guest complaint", audience: "partner", body: "Hi {{name}},\n\nThanks for letting us know. Please point the guest to support.zapnivo.com, where they can look up their rental and open a ticket. Rental charges and refunds are handled by Zapnivo, so your team doesn't need to resolve them.\n\n{{agent}}\nZapnivo Partner Support (ref {{ticket}})" },
];

export function renderMacro(m: Macro, vars: { name: string; ticket: string; agent: string }) {
  return m.body.replace(/\{\{(name|ticket|agent)\}\}/g, (_, k: "name" | "ticket" | "agent") => vars[k]);
}
