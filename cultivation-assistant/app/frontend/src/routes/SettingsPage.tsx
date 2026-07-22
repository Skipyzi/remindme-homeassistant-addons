import {
	Bell,
	Database,
	ExternalLink,
	Home,
	Moon,
	ShieldCheck,
	Sun,
} from "lucide-react";
import { useTheme } from "../app/theme-context";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/Card";

export function SettingsPage() {
	const { mode, setMode } = useTheme();

	return (
		<div className="page-stack settings-page">
			<section className="page-heading">
				<div>
					<p className="eyebrow">System</p>
					<h1>Settings</h1>
					<p>Manage appearance, Home Assistant, storage, and diagnostics.</p>
				</div>
			</section>
			<div className="settings-grid">
				<nav className="settings-nav" aria-label="Settings sections">
					<button className="active">General</button>
					<button>Home Assistant</button>
					<button>Notifications</button>
					<button>Data & storage</button>
					<button>Diagnostics</button>
				</nav>
				<div className="settings-panels">
					<Card>
						<CardHeader>
							<div>
								<CardTitle>Appearance</CardTitle>
								<p>Choose how Cultivation Assistant looks in this browser.</p>
							</div>
						</CardHeader>
						<CardContent>
							<fieldset className="theme-options">
								<legend className="sr-only">Theme</legend>
								<label>
									<input
										type="radio"
										name="theme"
										checked={mode === "light"}
										onChange={() => setMode("light")}
									/>
									<span>
										<Sun size={18} />
										Light<small>Bright and clear</small>
									</span>
								</label>
								<label>
									<input
										type="radio"
										name="theme"
										checked={mode === "dark"}
										onChange={() => setMode("dark")}
									/>
									<span>
										<Moon size={18} />
										Dark<small>Low-light rooms</small>
									</span>
								</label>
								<label>
									<input
										type="radio"
										name="theme"
										checked={mode === "system"}
										onChange={() => setMode("system")}
									/>
									<span>
										<Home size={18} />
										System<small>Match your device</small>
									</span>
								</label>
							</fieldset>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<div>
								<CardTitle>Home Assistant connection</CardTitle>
								<p>Uses the Supervisor connection provided to this app.</p>
							</div>
							<Badge tone="healthy">Connected</Badge>
						</CardHeader>
						<CardContent>
							<div className="connection-box">
								<div className="connection-icon">
									<ShieldCheck size={22} />
								</div>
								<div>
									<strong>Authenticated through Supervisor</strong>
									<span>Secrets are never stored in the browser.</span>
								</div>
								<Button variant="secondary" size="sm">
									View status <ExternalLink size={13} />
								</Button>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<div>
								<CardTitle>Preferences</CardTitle>
								<p>Defaults used across your grow spaces.</p>
							</div>
						</CardHeader>
						<CardContent className="preference-list">
							<label>
								<span>
									<Bell size={17} />
									<span>
										<strong>Guidance notifications</strong>
										<small>
											Show actionable observations in Home Assistant
										</small>
									</span>
								</span>
								<input type="checkbox" defaultChecked />
							</label>
							<label>
								<span>
									<Database size={17} />
									<span>
										<strong>Measurement units</strong>
										<small>Temperature and volume display</small>
									</span>
								</span>
								<select defaultValue="metric">
									<option value="metric">Metric (°C, L)</option>
									<option value="imperial">Imperial (°F, gal)</option>
								</select>
							</label>
						</CardContent>
					</Card>
					<div className="settings-actions">
						<span>Changes are stored locally in your Home Assistant app.</span>
						<Button>Save changes</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
