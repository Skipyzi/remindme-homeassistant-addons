import { ArrowLeft, Sprout } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Card } from "../components/ui/Card";

export function ComingSoonPage() {
	const name = useRouterState({
		select: (state) =>
			state.location.pathname.split("/").filter(Boolean).join(" / ") || "Page",
	});
	return (
		<div className="page-stack">
			<section className="page-heading">
				<div>
					<p className="eyebrow">Next vertical slice</p>
					<h1 className="capitalize">{name}</h1>
					<p>
						This workspace is ready for its domain feature and API connection.
					</p>
				</div>
			</section>
			<Card className="empty-state">
				<div className="empty-state__icon">
					<Sprout size={27} />
				</div>
				<h2>Foundation planted</h2>
				<p>
					The application shell, navigation, responsive states, and component
					tokens are in place.
				</p>
				<Link to="/" className="empty-state__link">
					<ArrowLeft size={15} /> Return to overview
				</Link>
			</Card>
		</div>
	);
}
