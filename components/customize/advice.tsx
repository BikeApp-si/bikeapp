import type { Part } from "@/server/kernel/chats";

// Customize advice (C3): each group under a small label, each item with its title, why it helps, its fields and where
// it lives; then where to start. Text only, as chat replies are; the buttons and links follow it in the message.

type Advice = Extract<Part, { kind: "advice" }>;

const WHERE: Record<Advice["groups"][number]["items"][number]["place"], string> = {
  here: "In this app",
  capability: "Its own app",
  view: "A view",
  report: "A report",
  not_yet: "Not in Bike yet",
};

export function AdviceReply({ advice }: { advice: Advice }) {
  return (
    <div className="flex flex-col gap-4">
      {advice.groups.map((g) => (
        <section key={g.title} className="flex flex-col gap-3">
          <div className="text-[12.5px] font-medium tracking-[0.02em] text-muted uppercase">{g.title}</div>
          <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
            {g.items.map((i) => (
              <li key={i.title} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold">{i.title}</span>
                  <span className="text-[13.5px] text-muted">{WHERE[i.place]}</span>
                </div>
                <span>{i.why}</span>
                {i.fields.length ? <span className="text-[15px] text-muted">{i.fields.join(" · ")}</span> : null}
              </li>
            ))}
          </ol>
        </section>
      ))}
      <div className="border-t border-line pt-3">
        <span className="font-semibold">Where to start: </span>
        {advice.start}
      </div>
    </div>
  );
}
