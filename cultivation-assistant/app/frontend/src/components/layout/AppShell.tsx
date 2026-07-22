import {
	BarChart3,
	Bell,
	BookOpen,
	Boxes,
	CalendarRange,
	CheckSquare,
	Droplets,
	FlaskConical,
	Gauge,
	LayoutDashboard,
	Leaf,
	Menu,
	Moon,
	PanelLeftClose,
	Sun,
	Settings,
	Sprout,
	WalletCards,
	X,
} from "lucide-react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useHealthQuery } from "../../api/system";
import { useTheme } from "../../app/theme-context";
import { cn } from "../../lib";
import { Button } from "../ui/Button";

const groups = [
	{
		label: "Cultivation",
		items: [
			{ to: "/", label: "Overview", icon: LayoutDashboard },
			{ to: "/grow-spaces", label: "Grow spaces", icon: Boxes },
			{ to: "/plants", label: "Plants", icon: Sprout },
			{ to: "/timeline", label: "Timeline", icon: CalendarRange },
		],
	},
	{
		label: "Operations",
		items: [
			{ to: "/environment", label: "Environment", icon: Gauge },
			{ to: "/reservoirs", label: "Reservoirs", icon: Droplets },
			{ to: "/feeding", label: "Feeding", icon: FlaskConical },
			{ to: "/tasks", label: "Tasks", icon: CheckSquare },
			{ to: "/costs", label: "Costs", icon: WalletCards },
		],
	},
	{
		label: "Reference",
		items: [
			{ to: "/library", label: "Library", icon: BookOpen },
			{ to: "/reports", label: "Reports", icon: BarChart3 },
			{ to: "/settings", label: "Settings", icon: Settings },
		],
	},
];

export function AppShell() {
	const [open, setOpen] = useState(false);
	const { resolvedTheme, setMode } = useTheme();
	const health = useHealthQuery();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<div className="app-frame">
			{open && (
				<button
					className="fixed inset-0 z-30 bg-black/35 lg:hidden"
					aria-label="Close navigation"
					onClick={() => setOpen(false)}
				/>
			)}
			<aside className={cn("sidebar", open && "sidebar--open")}>
				<div className="sidebar__brand">
					<div className="brand-mark">
						<Leaf size={20} fill="currentColor" />
					</div>
					<div>
						<strong>Cultivation Records</strong>
						<span>Office of Home Agriculture</span>
					</div>
					<Button
						variant="ghost"
						size="icon"
						className="ml-auto text-[var(--ink)] lg:hidden"
						aria-label="Close menu"
						onClick={() => setOpen(false)}
					>
						<X size={19} />
					</Button>
				</div>
				<nav className="sidebar__nav" aria-label="Primary navigation">
					{groups.map((group) => (
						<div className="nav-group" key={group.label}>
							<p>{group.label}</p>
							{group.items.map((item) => {
								const active =
									item.to === "/"
										? pathname === "/"
										: pathname.startsWith(item.to);
								return (
									<Link
										key={item.to}
										to={item.to}
										className={cn("nav-link", active && "nav-link--active")}
										onClick={() => setOpen(false)}
									>
										<item.icon size={17} strokeWidth={1.8} />
										<span>{item.label}</span>
										{item.label === "Environment" && <i />}
									</Link>
								);
							})}
						</div>
					))}
				</nav>
				<div
					className={cn(
						"sidebar__status",
						health.isError && "sidebar__status--unavailable",
					)}
				>
					<span className="status-orbit">
						<span />
					</span>
					<div>
						<strong>Cultivation app</strong>
						<small>
							{health.isPending
								? "Checking local service…"
								: health.isError
									? "Unavailable · retrying"
									: `Connected · v${health.data.version}`}
						</small>
					</div>
				</div>
			</aside>

			<div className="main-column">
				<header className="topbar">
					<Button
						variant="ghost"
						size="icon"
						className="lg:hidden"
						aria-label="Open navigation"
						onClick={() => setOpen(true)}
					>
						<Menu size={20} />
					</Button>
					<PanelLeftClose
						className="hidden text-[var(--text-faint)] lg:block"
						size={18}
					/>
					<span className="file-reference hidden md:inline">
						FILE CA–2026–00418
					</span>
					<div className="topbar__space">
						<span className="hidden sm:inline">Active premises</span>
						<button>
							North tent <span>⌄</span>
						</button>
					</div>
					<div className="ml-auto flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon"
							className="theme-toggle"
							aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
							onClick={() =>
								setMode(resolvedTheme === "dark" ? "light" : "dark")
							}
						>
							{resolvedTheme === "dark" ? (
								<Sun size={18} />
							) : (
								<Moon size={18} />
							)}
						</Button>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Notifications"
							className="relative"
						>
							<Bell size={18} />
							<i className="notification-dot" />
						</Button>
						<div className="user-avatar" aria-label="User profile">
							GA
						</div>
					</div>
				</header>
				<main className="page-container">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
