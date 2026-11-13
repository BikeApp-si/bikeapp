import { describe, expect, it } from "vitest";
import { orgChart, type OrgNode, type OrgPerson } from "./org-chart";

const p = (id: string, manager?: string, noManager = false): OrgPerson => ({ id, manager: manager ? { id: manager } : null, noManager });
const shape = (n: OrgNode<OrgPerson>): unknown => (n.reports.length ? { [n.person.id]: n.reports.map(shape) } : n.person.id);

describe("the Org chart", () => {
  it("draws Fernwood: Wade at the top, each lead with their people in People's order, Leo and Aisha under No manager", () => {
    const people = [
      p("wade"), p("priya", "wade"), p("maya", "priya"), p("omar", "priya"), p("kim", "priya"), p("ana", "priya"),
      p("dev", "wade"), p("rita", "dev"), p("leo", undefined, true), p("nina", "dev"),
      p("krishna", "wade"), p("jon", "krishna"), p("aisha", undefined, true), p("lena", "krishna"),
    ];
    const { tops, noManager } = orgChart(people);
    expect(tops.map(shape)).toEqual([{ wade: [{ priya: ["maya", "omar", "kim", "ana"] }, { dev: ["rita", "nina"] }, { krishna: ["jon", "lena"] }] }]);
    expect(noManager.map((x) => x.id)).toEqual(["leo", "aisha"]);
  });

  it("puts people caught in a loop of managers under No manager, and draws every person once", () => {
    const { tops, noManager } = orgChart([p("a"), p("b", "c"), p("c", "b"), p("d", "a"), p("e", "e")]);
    expect(tops.map(shape)).toEqual([{ a: ["d"] }]);
    expect(noManager.map((x) => x.id)).toEqual(["b", "c", "e"]);
  });

  it("starts at everyone with no manager, and a manager who isn't in the list counts as none", () => {
    const { tops } = orgChart([p("a"), p("b"), p("c", "gone")]);
    expect(tops.map(shape)).toEqual(["a", "b", "c"]);
  });
});
