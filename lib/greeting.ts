// "Good afternoon" in the workspace's time zone (developer notes §3).
export function partOfDay(now: Date, timeZone: string): "morning" | "afternoon" | "evening" {
  const hour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(now));
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

// Admin Home once capabilities exist: one heading per day per person (developer notes §3).
const HEADINGS = [
  "What’s on the agenda today, {first}?",
  "What should {company} get done today?",
  "Anything to plan, approve or set up today?",
  "What are we building for {company} today?",
  "Where should we start today, {first}?",
  "What’s next for {company}?",
];

export function dailyHeading(personId: string, day: string, first: string, company: string): string {
  let h = 0;
  for (const ch of `${personId}:${day}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HEADINGS[h % HEADINGS.length]!.replace("{first}", first).replace("{company}", company);
}
