import type { PublicMessage } from "@/lib/helpdesk/service";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" });

const WHO: Record<string, string> = { ai: "Zapnivo Assistant (AI)", system: "Zapnivo", agent: "Zapnivo Support", customer: "You", partner: "You" };

/** Renders a thread for the person who owns it. `mine` = authorType that should align right ("customer" or "partner"). */
export function Conversation({ messages, mine = "customer" }: { messages: PublicMessage[]; mine?: "customer" | "partner" }) {
  return (
    <ol className="space-y-4" aria-label="Conversation">
      {messages.map((m, i) => {
        const own = m.authorType === mine;
        return (
          <li key={i} className={own ? "flex justify-end" : ""}>
            <div className={`max-w-[92%] rounded-2xl p-4 sm:max-w-[80%] ${own ? "rounded-br-md bg-forest text-white" : m.authorType === "agent" ? "rounded-bl-md border-l-4 border-lime bg-white shadow-sm" : "rounded-bl-md bg-white shadow-sm"}`}>
              <p className={`text-xs font-extrabold uppercase tracking-wider ${own ? "text-lime" : "text-forest/70"}`}>
                {m.authorType === "agent" ? m.authorName || WHO.agent : WHO[m.authorType]} <span className="font-medium normal-case tracking-normal opacity-70">· {when(m.createdAt)}</span>
              </p>
              <p className="mt-2 whitespace-pre-wrap text-[0.95rem] leading-7">{m.body}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
