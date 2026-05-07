/**
 * Session Switcher Extension
 *
 * Uses fff (Fast File Finder) for high-performance fuzzy session switching.
 * Sessions are displayed with formatted timestamps and filtered in real-time.
 *
 * Usage:
 *   /switch - fuzzy search and switch sessions (uses fff if available)
 *   /switch --list - list all sessions without fuzzy filtering
 *
 * Requirements:
 *   npm install @ff-labs/fff-node
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Container, Input, Key, matchesKey, Text, Spacer } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";

import { FileFinder } from "@ff-labs/fff-node";

interface SessionInfo {
	file: string;
	path: string;
	timestamp: Date;
	name?: string;
	projectDir: string;
	relativePath: string;
}

function formatRelativeTime(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHour = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHour / 24);

	if (diffSec < 60) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	if (diffHour < 24) return `${diffHour}h ago`;
	if (diffDay < 7) return `${diffDay}d ago`;
	if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
	if (diffDay < 365) return `${Math.floor(diffDay / 30)}mo ago`;
	return `${Math.floor(diffDay / 365)}y ago`;
}

function formatAbsoluteTime(date: Date): string {
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	const timeStr = date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});

	if (isToday) return `Today ${timeStr}`;

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const isYesterday = date.toDateString() === yesterday.toDateString();
	if (isYesterday) return `Yesterday ${timeStr}`;

	const daysAgo = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
	if (daysAgo < 7) return `${daysAgo}d ago ${timeStr}`;

	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	}) + ` ${timeStr}`;
}

async function parseSessionName(filePath: string): Promise<string | undefined> {
	try {
		const content = await readFile(filePath, "utf-8");
		const lines = content.split("\n");
		let name: string | undefined;
		// Session names are stored as session_info entries, not in the header.
		// Walk all entries and use the latest one (empty names clear the title).
		for (const line of lines) {
			if (!line) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_info") {
					name = entry.name?.trim() || undefined;
				}
			} catch { /* skip malformed lines */ }
		}
		return name;
	} catch {
		return undefined;
	}
}

async function listSessions(): Promise<SessionInfo[]> {
	const sessionsDir = join(getAgentDir(), "sessions");
	const sessions: SessionInfo[] = [];

	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			try {
				const subDir = join(sessionsDir, entry.name);
				const files = await readdir(subDir);

				for (const file of files) {
					if (!file.endsWith(".jsonl")) continue;

					const filePath = join(subDir, file);
					const fileStat = await stat(filePath);

					const name = await parseSessionName(filePath);

					sessions.push({
						file,
						path: filePath,
						timestamp: fileStat.mtime,
						name,
						projectDir: entry.name.replace(/--/g, "/"),
						relativePath: join(entry.name, file),
					});
				}
			} catch {
				// Skip inaccessible directories
			}
		}
	} catch {
		// Sessions directory doesn't exist or is inaccessible
	}

	// Sort by timestamp, most recent first
	sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

	return sessions;
}

function displaySession(session: SessionInfo, maxWidth: number): string {
	const relTime = formatRelativeTime(session.timestamp);
	const absTime = formatAbsoluteTime(session.timestamp);

	const displayName = session.name || session.file.replace(".jsonl", "").replace(/^\d+_/, "");
	const truncatedName = displayName.length > maxWidth - 45
		? displayName.slice(0, maxWidth - 48) + "..."
		: displayName;

	return `${truncatedName.padEnd(Math.min(maxWidth - 45, 35))} ${relTime.padEnd(8)} ${absTime}`;
}

/**
 * Simple fuzzy match for when fff is not available.
 * Returns score (higher = better) or -1 if no match.
 */
function simpleFuzzyMatch(pattern: string, text: string): number {
	const patternLower = pattern.toLowerCase();
	const textLower = text.toLowerCase();

	let patternIdx = 0;
	let score = 0;
	let lastMatchIdx = -1;

	for (let i = 0; i < textLower.length && patternIdx < patternLower.length; i++) {
		if (textLower[i] === patternLower[patternIdx]) {
			score += 1;
			if (lastMatchIdx === i - 1) score += 2;
			if (i === 0 || text[i - 1] === " " || text[i - 1] === "/" || text[i - 1] === "-") score += 3;
			lastMatchIdx = i;
			patternIdx++;
		}
	}

	if (patternIdx < patternLower.length) return -1;
	return score;
}

export default function sessionSwitcherExtension(pi: ExtensionAPI) {
	pi.registerCommand("switch", {
		description: "Switch to another session with fuzzy find (powered by fff)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("sessions requires interactive mode", "error");
				return;
			}

			const listOnly = args?.includes("--list");
			const allSessions = await listSessions();

			if (allSessions.length === 0) {
				ctx.ui.notify("No sessions found", "info");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();

			// Try to initialize fff finder
			let finder: FileFinder | null = null;
			let useFff = !listOnly;

			if (useFff && FileFinder.isAvailable()) {
				try {
					const sessionsDir = join(getAgentDir(), "sessions");
					const result = await FileFinder.create({
						basePath: sessionsDir,
						aiMode: true,
						disableWatch: true,
						disableContentIndexing: true,
					});

					if (result.ok) {
						finder = result.value;
						await finder.waitForScan(3000);
					} else {
						ctx.ui.notify(`fff init: ${result.error}`, "warning");
					}
				} catch (e) {
					console.error("fff init error:", e);
					useFff = false;
				}
			} else {
				useFff = false;
			}

			let filteredSessions = allSessions;
			let selectedIndex = 0;

			await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();

				// Title
				const fffLabel = useFff ? " (fff)" : "";
				container.addChild(new Text(theme.fg("accent", theme.bold(`Switch Session${fffLabel}`))));

				// Search input
				const searchInput = new Input();

				const doFilter = (value: string) => {
					if (value.trim() === "") {
						filteredSessions = allSessions;
					} else if (useFff && finder) {
						// Use fff for fuzzy search
						const searchResult = finder.fileSearch(value, { pageSize: 50 });
						if (searchResult.ok) {
							const matchedFiles = new Set(
								searchResult.value.items.map((item) => item.relativePath)
							);
							// Reorder: matched first, then unmatched
							const matched: SessionInfo[] = [];
							const unmatched: SessionInfo[] = [];
							for (const session of allSessions) {
								if (matchedFiles.has(session.relativePath)) {
									matched.push(session);
								} else {
									unmatched.push(session);
								}
							}
							filteredSessions = [...matched, ...unmatched];
						} else {
							// Fallback to simple filtering
							const query = value.toLowerCase();
							filteredSessions = allSessions.filter(
								(s) =>
									s.file.toLowerCase().includes(query) ||
									s.path.toLowerCase().includes(query) ||
									s.name?.toLowerCase().includes(query)
							);
						}
					} else {
						// Simple text filtering with fuzzy scoring
						const scored = allSessions
							.map((s) => ({
								session: s,
								score: Math.max(
									simpleFuzzyMatch(value, s.file),
									simpleFuzzyMatch(value, s.path.replace(/\//g, " ")),
									s.name ? simpleFuzzyMatch(value, s.name) : -1,
								),
							}))
							.filter((x) => x.score >= 0)
							.sort((a, b) => b.score - a.score)
							.map((x) => x.session);

						// If no fuzzy matches, show all with simple filter
						filteredSessions = scored.length > 0 ? scored : allSessions.filter(
							(s) =>
								s.file.toLowerCase().includes(value.toLowerCase()) ||
								s.path.toLowerCase().includes(value.toLowerCase()) ||
								s.name?.toLowerCase().includes(value.toLowerCase())
						);
					}
					selectedIndex = 0;
					tui.requestRender();
				};
				container.addChild(searchInput);
				container.addChild(new Spacer(1));

				// Session list
				const sessionsContainer = new Container();

				const updateDisplay = () => {
					sessionsContainer.clear();
					const visibleCount = Math.min(filteredSessions.length, 15);

					if (filteredSessions.length === 0) {
						sessionsContainer.addChild(new Text(theme.fg("warning", "No matching sessions")));
					} else {
						for (let i = 0; i < visibleCount; i++) {
							const session = filteredSessions[i]!;
							const isSelected = i === selectedIndex;
							const isCurrent = session.path === currentSessionFile;

							let lineText: string;
							if (isCurrent) {
								lineText = theme.fg("success", "> ") + theme.fg("muted", displaySession(session, 80));
							} else if (isSelected) {
								lineText = theme.fg("accent", "> ") + displaySession(session, 80);
							} else {
								lineText = "  " + displaySession(session, 80);
							}

							sessionsContainer.addChild(new Text(lineText, 1, 0));
						}

						if (filteredSessions.length > visibleCount) {
							sessionsContainer.addChild(
								new Text(theme.fg("dim", `Showing ${visibleCount} of ${filteredSessions.length}`), 1, 0)
							);
						}
					}

					sessionsContainer.addChild(new Spacer(1));
					sessionsContainer.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					sessionsContainer.addChild(
						new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"))
					);
				};

				updateDisplay();
				container.addChild(sessionsContainer);
				searchInput.focused = true;

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						const visibleCount = Math.min(filteredSessions.length, 15);

						if (matchesKey(data, Key.up)) {
							if (selectedIndex > 0) {
								selectedIndex--;
								updateDisplay();
							}
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							if (selectedIndex < filteredSessions.length - 1 && selectedIndex < visibleCount - 1) {
								selectedIndex++;
								updateDisplay();
							}
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							if (filteredSessions.length > 0 && selectedIndex < filteredSessions.length) {
								done(filteredSessions[selectedIndex]!.path);
							}
						} else if (matchesKey(data, Key.escape)) {
							done(null);
						} else {
							searchInput.handleInput(data);
							doFilter(searchInput.getValue());
						}
					},
				};
			}).then(async (selectedPath) => {
				// Cleanup fff finder
				if (finder) {
					finder.destroy();
				}

				if (selectedPath) {
					await ctx.switchSession(selectedPath);
				}
			});
		},
	});
}