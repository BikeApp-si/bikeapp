import { Check } from "lucide-react";
import { Button } from "@/components/buttons";
import { PersonChip } from "@/components/chips";
import { MoveBlock } from "@/components/chat/move-block";
import { Paragraphs, ReplyTable, Rich } from "@/components/chat/parts";
import type { DraftView } from "@/server/chat/customize-view";

// Bike's preview of a Customize change (6c, 6f, 6h): what changes and where, what it moves, what it does to
// today's rows, then Apply or Change something. Once applied or replaced it folds to one line (6d, 6i).

const plural = (n: number, w: { one: string; many: string }) => `${n} ${n === 1 ? w.one : w.many}`;

export function ChangeReply({ view, live, busy, onApply, onChange, tints }: { view: DraftView; live: boolean; busy: boolean; onApply: () => void; onChange: () => void; tints: Map<string, string> }) {
  const d = view.draft;
  if (view.state !== "waiting" || !live)
    return (
      <div className="text-base text-muted">
        {d.collapsed.lead} … <b className="font-medium text-ink">{d.collapsed.tail}</b>
      </div>
    );

  // A data move that can't map every row (m27-b): the rows and what to do; nothing to apply.
  const stuck = d.moves?.find((m) => !m.ok);
  if (stuck)
    return (
      <div className="flex flex-col gap-2.5 text-base leading-[1.6]">
        <Paragraphs text={d.reply} />
        <MoveBlock move={stuck} />
      </div>
    );

  const fixes = d.renames.filter((r) => r.uses.some((u) => u.kind !== "total"));
  const onlyRenames = fixes.length > 0 && d.changes.length === d.renames.length;
  return (
    <div className="flex flex-col gap-2.5 text-base leading-[1.6]">
      <Paragraphs text={d.reply} />
      {d.rule?.repeats ? (
        // M32 (m32-a): a repeating rule: when, the next date, the row it adds, and the dates it would have added.
        <>
          <ReplyTable head={["When", "Then"]} rows={[[d.rule.when, d.rule.then]]} />
          <div>
            {d.rule.repeats.next ? (
              <>
                Checked once a day; the next one is added on <b className="font-semibold">{d.rule.repeats.next}</b>. Each one reads:
              </>
            ) : (
              "Its last date has passed, so it won't add any. Each one would read:"
            )}
          </div>
          <ReplyTable
            head={d.rule.repeats.columns}
            rows={[d.rule.repeats.values.map((v, i) => (v.person ? <PersonChip key={i} name={v.text} tint={tints.get(v.text) ?? "#62748E"} /> : v.text))]}
          />
          <div>
            {d.rule.repeats.past
              ? `On your last 90 days it would have added ${plural(d.rule.repeats.past, d.rule.rows)}: ${d.rule.repeats.pastWords}. Nothing is added for those.`
              : "On your last 90 days it wouldn't have added any."}
          </div>
        </>
      ) : d.rule ? (
        <>
          <ReplyTable head={["When", "Then"]} rows={[[d.rule.when, d.rule.then]]} />
          <div>
            {d.rule.daily ? `Checked once a day, once per ${d.rule.rows.one}. ` : ""}
            {d.rule.preview.rows.length
              ? `On your last 90 days it would have run ${plural(d.rule.preview.rows.length, { one: "time", many: "times" })}:`
              : "On your last 90 days it wouldn't have run."}
          </div>
          {d.rule.preview.rows.length ? (
            <ReplyTable
              head={d.rule.preview.columns}
              widths={d.rule.preview.columns.map((_, i) => (i === d.rule!.preview.columns.length - 1 ? "120px" : undefined))}
              rows={d.rule.preview.rows.map((r) => r.map((cell, i) => (d.rule!.preview.columns.length === 3 && i === 1 && cell ? <PersonChip key={i} name={cell} tint={tints.get(cell) ?? "#62748E"} /> : cell)))}
            />
          ) : null}
        </>
      ) : onlyRenames ? null : (
        <ReplyTable head={["Change", "Where"]} widths={[undefined, "170px"]} rows={d.changes.map((c) => [c.explain, c.where])} />
      )}
      {fixes.map((r) => {
        const uses = r.uses.filter((u) => u.kind !== "total");
        const connections = uses.filter((u) => u.kind === "connection").length;
        const rules = uses.length - connections;
        const what = [connections ? plural(connections, { one: "connection", many: "connections" }) : "", rules ? plural(rules, { one: "rule", many: "rules" }) : ""].filter(Boolean).join(" and ");
        return (
          <div key={r.from} className="flex flex-col gap-2.5">
            <div>
              <Rich text={`**This also affects ${what}** that start at ${r.from}. I've moved ${uses.length === 2 ? "both" : uses.length === 1 ? "it" : "them"} to ${r.to}; the text on the right shows the result:`} />
            </div>
            <ReplyTable head={[`Uses ${r.from}`, "Now starts at"]} widths={[undefined, "150px"]} rows={uses.map((u) => [`${u.kind === "connection" ? "Connection" : "Rule"}: ${u.text.replace(/\.$/, "")}`, r.to])} />
          </div>
        );
      })}
      {d.moves?.map((m, i) => <MoveBlock key={i} move={m} />)}
      {d.impact ? (
        <div>
          <Rich text={d.impact} />
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button kind="primary" disabled={busy} onClick={onApply} className="px-4">
          <Check size={14} strokeWidth={2.2} />
          {d.button}
        </Button>
        <Button disabled={busy} onClick={onChange}>
          Change something
        </Button>
      </div>
    </div>
  );
}
