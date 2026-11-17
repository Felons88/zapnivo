import { createHash, createSign } from "node:crypto";
import { SITE } from "./site";
import { giftLaunchStatus } from "./gift-launch";

/** A merchant gift pass, not a network payment card or tap-to-pay credential. */
export const googleWalletPassReady = () => giftLaunchStatus().status === "enabled" && Boolean(
  process.env.GOOGLE_WALLET_ISSUER_ID && process.env.GOOGLE_WALLET_GIFT_CLASS_ID &&
  process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_WALLET_PRIVATE_KEY,
);

export function googleWalletGiftPassUrl(profileId: string): string | null {
  if (!googleWalletPassReady()) return null;
  const issuer = process.env.GOOGLE_WALLET_ISSUER_ID!;
  const classId = process.env.GOOGLE_WALLET_GIFT_CLASS_ID!;
  if (!classId.startsWith(`${issuer}.`)) return null;
  const suffix = createHash("sha256").update(profileId).digest("hex").slice(0, 20);
  const objectId = `${issuer}.zapnivo_${suffix}`;
  const cardNumber = `ZPN-${suffix.toUpperCase()}`;
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL!, aud: "google", typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000), origins: [new URL(SITE.url).hostname],
    payload: { giftCardObjects: [{ id: objectId, classId, state: "ACTIVE", cardNumber,
      textModulesData: [{ id: "use", header: "Zapnivo charging credit", body: "Use your credit in the Zapnivo app. Open the app for your current balance. This pass is not a tap-to-pay card." }],
    }] },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode(header)}.${encode(claims)}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(data);
    const sig = signer.sign(process.env.GOOGLE_WALLET_PRIVATE_KEY!.replace(/\\n/g, "\n"), "base64url");
    return `https://pay.google.com/gp/v/save/${data}.${sig}`;
  } catch { return null; }
}
