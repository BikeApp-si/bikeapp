// Time zones offered on 2a, as people name them. The browser's own zone goes first.
export const TIME_ZONES: { id: string; label: string }[] = [
  { id: "America/Chicago", label: "Central Time (US) · Austin" },
  { id: "America/New_York", label: "Eastern Time (US) · New York" },
  { id: "America/Denver", label: "Mountain Time (US) · Denver" },
  { id: "America/Los_Angeles", label: "Pacific Time (US) · San Francisco" },
  { id: "America/Toronto", label: "Eastern Time (Canada) · Toronto" },
  { id: "America/Sao_Paulo", label: "Brasília Time · São Paulo" },
  { id: "Europe/London", label: "UK Time · London" },
  { id: "Europe/Dublin", label: "Irish Time · Dublin" },
  { id: "Europe/Lisbon", label: "Western European Time · Lisbon" },
  { id: "Europe/Berlin", label: "Central European Time · Berlin" },
  { id: "Europe/Ljubljana", label: "Central European Time · Ljubljana" },
  { id: "Europe/Paris", label: "Central European Time · Paris" },
  { id: "Europe/Athens", label: "Eastern European Time · Athens" },
  { id: "Africa/Lagos", label: "West Africa Time · Lagos" },
  { id: "Africa/Nairobi", label: "East Africa Time · Nairobi" },
  { id: "Asia/Dubai", label: "Gulf Time · Dubai" },
  { id: "Asia/Kolkata", label: "India Standard Time · Bengaluru" },
  { id: "Asia/Singapore", label: "Singapore Time · Singapore" },
  { id: "Asia/Tokyo", label: "Japan Time · Tokyo" },
  { id: "Australia/Sydney", label: "Eastern Australia Time · Sydney" },
  { id: "Pacific/Auckland", label: "New Zealand Time · Auckland" },
  { id: "UTC", label: "UTC" },
];

export function isTimeZone(id: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

// Old names some browsers still report.
const ALIASES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Europe/Kiev": "Europe/Kyiv",
  "US/Central": "America/Chicago",
  "US/Eastern": "America/New_York",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
};

export function timeZoneOptions(zone: string | null) {
  const browserZone = zone ? (ALIASES[zone] ?? zone) : null;
  const known = TIME_ZONES.find((z) => z.id === browserZone);
  if (known) return [known, ...TIME_ZONES.filter((z) => z !== known)];
  if (browserZone && isTimeZone(browserZone)) return [{ id: browserZone, label: browserZone.replace(/_/g, " ") }, ...TIME_ZONES];
  return TIME_ZONES;
}
