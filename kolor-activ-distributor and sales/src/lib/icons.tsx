// One place for the app's icons, so each page and tab always carries the same picture.
import {
  LayoutDashboard, Boxes, Store, ShoppingBag, Wallet, ClipboardList, ShieldCheck, ChartColumn, Tags, History, Settings, LogOut, Upload, LayoutGrid, Network,
  PackageCheck, CalendarCheck, NotebookText, Package, UsersRound, Warehouse, Building2, PackageX, Hourglass, Scale, UserRoundX, TrendingDown, CloudOff, MapPin, ClipboardX, Bell,
  type LucideIcon,
} from "lucide-react";

const PAGE: Record<string, LucideIcon> = {
  Dashboard: LayoutDashboard, Inventory: Boxes, Distributors: Store, Retailers: ShoppingBag, Collections: Wallet, "SO reports": ClipboardList, "SO checks": ShieldCheck,
  Reports: ChartColumn, Pricing: Tags, History, Settings,
};
const TAB: Record<string, LucideIcon> = {
  // SO reports
  upload: Upload, overview: LayoutGrid, team: Network, checks: PackageCheck, attendance: CalendarCheck, log: NotebookText, products: Package, staff: UsersRound,
  // Distributors
  DISTRIBUTOR: Store, SUPER_STOCKIST: Warehouse, GODOWN: Building2, tree: Network,
  // SO checks
  oversell: PackageX, aged: Hourglass, vs: Scale, retailers: UserRoundX, low: TrendingDown, stale: CloudOff, near: MapPin, counts: ClipboardX,
  // Shell
  logout: LogOut, bell: Bell,
};

/** A line icon sized to sit beside text; decorative, so screen readers skip it. */
function draw(I: LucideIcon | undefined, size: number) {
  return I ? <I className="ico" size={size} strokeWidth={1.9} aria-hidden focusable={false} /> : null;
}
export const PageIcon = ({ page, size = 18 }: { page: string; size?: number }) => draw(PAGE[page], size);
export const TabIcon = ({ id, size = 16 }: { id: string; size?: number }) => draw(TAB[id], size);
