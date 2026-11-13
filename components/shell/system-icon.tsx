import { BarChart3, House, Inbox, LayoutGrid, MessageCircle, Network, ScrollText, Search, Users, type LucideIcon } from "lucide-react";
import { SYSTEM_COLORS, type SystemPage } from "@/lib/system-colors";

const ICONS: Record<SystemPage, LucideIcon> = {
  search: Search,
  home: House,
  inbox: Inbox,
  chats: MessageCircle,
  reports: BarChart3,
  people: Users,
  audit: ScrollText,
  ontology: Network,
  settings: LayoutGrid,
};

// A system page's icon in its fixed colour, as the sidebar and the top bar show it (T1).
export function SystemIcon({ page, size = 16 }: { page: SystemPage; size?: number }) {
  const Icon = ICONS[page];
  return <Icon size={size} strokeWidth={1.8} color={SYSTEM_COLORS[page]} />;
}
