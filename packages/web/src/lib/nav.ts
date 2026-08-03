import {
  Home,
  MessageSquare,
  Users,
  Clock,
  LayoutGrid,
  Activity,
  Zap,
  Settings,
  BookOpen,
  Network,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "ホーム", icon: Home },
  { href: "/chat", label: "チャット", icon: MessageSquare },
  { href: "/org", label: "組織", icon: Users },
  { href: "/kanban", label: "カンバン", icon: LayoutGrid },
  { href: "/cron", label: "スケジュール", icon: Clock },
  { href: "/logs", label: "アクティビティ", icon: Activity },
  { href: "/placements", label: "台帳", icon: BookOpen },
  { href: "/skills", label: "スキル", icon: Zap },
  { href: "/settings/topology", label: "構成", icon: Network },
  { href: "/settings", label: "設定", icon: Settings },
]

export function isNavItemActive(pathname: string, href: string, items: NavItem[] = NAV_ITEMS): boolean {
  if (href === "/") return pathname === "/"
  if (href === "/settings") return pathname === "/settings"
  if (href === "/settings/topology") return pathname.startsWith("/settings/")
  if (!pathname.startsWith(href)) return false
  return !items.some((item) => item.href !== href && item.href.length > href.length && pathname.startsWith(item.href))
}
