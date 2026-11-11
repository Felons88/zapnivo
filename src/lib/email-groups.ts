import { sendToCustomer } from "./email-triggers";
import { fmt } from "./pricing";
import { subUrl } from "./site";

/**
 * Rental-group lifecycle emails. Queued through the same helpdesk outbox as
 * rental mail via sendToCustomer — event/template names are prefixed
 * `groups.` so they stay distinct from other notifications.
 */

const META = { template: "group_funding", sender: "billing" } as const;
const groupUrl = (groupId: string) => subUrl("customer", `/groups/${groupId}`);

/** Sent to the organizer after a group_credit_purchases row is funded by the webhook. */
export async function sendGroupFunded(args: { email: string; groupId: string; groupName: string; amountCents: number }) {
  const subject = `${fmt(args.amountCents)} added to ${args.groupName}'s credit pool`;
  const body = [
    `Hi,`,
    ``,
    `Your payment went through — ${fmt(args.amountCents)} was added to the shared credit pool for ${args.groupName}.`,
    `The pool is informational: members still rent individually at any station, and staff see the balance when helping the group.`,
    ``,
    `View the group and its funding history: ${groupUrl(args.groupId)}`,
    ``,
    `— Zapnivo`,
  ].join("\n");
  return sendToCustomer(args.email, subject, body, null, null, { ...META, event: "groups.credit_funded" });
}
