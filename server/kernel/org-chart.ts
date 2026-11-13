// The Org chart (0.5, M28, m28-c): People drawn from who reports to whom, read only. At the top, everyone with no
// manager whom the import didn't flag (the founder); under each person, the people who report to them, in People's
// order. "No manager" holds the people whose manager wasn't found, and anyone caught in a loop of managers.

export type OrgPerson = { id: string; manager: { id: string } | null; noManager: boolean };
export type OrgNode<P extends OrgPerson> = { person: P; reports: OrgNode<P>[] };

export function orgChart<P extends OrgPerson>(people: readonly P[]): { tops: OrgNode<P>[]; noManager: P[] } {
  const ids = new Set(people.map((p) => p.id));
  const reports = new Map<string, P[]>();
  for (const p of people) {
    const m = p.manager?.id;
    if (m && ids.has(m) && m !== p.id) reports.set(m, [...(reports.get(m) ?? []), p]);
  }
  const placed = new Set<string>();
  const node = (p: P): OrgNode<P> => {
    placed.add(p.id);
    return { person: p, reports: (reports.get(p.id) ?? []).filter((r) => !placed.has(r.id)).map(node) };
  };
  const tops = people.filter((p) => !p.noManager && (!p.manager || !ids.has(p.manager.id))).map(node);
  return { tops, noManager: people.filter((p) => !placed.has(p.id)) };
}
