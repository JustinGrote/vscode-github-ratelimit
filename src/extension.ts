/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/


import * as vscode from 'vscode';
import { Octokit } from '@octokit/core';

let myStatusBarItem: vscode.StatusBarItem;
let intervalId: ReturnType<typeof setInterval> | undefined;
let exceededDate: Date | undefined;
let extensionContext: vscode.ExtensionContext;
let webviewPanel: vscode.WebviewPanel | undefined;
// Keep history in-memory only; reset when extension reloads
const rateLimitHistory: Record<string, Array<[number, number]>> = {};
// Keep latest limits in-memory (not persisted)
const rateLimitLimits: Record<string, number> = {};

export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	const { subscriptions } = context;
	let pollInterval = vscode.workspace.getConfiguration('githubRateLimit').get<number>('pollIntervalSeconds', 1);
	myStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	myStatusBarItem.name = 'GitHub Rate Limit';
	subscriptions.push(myStatusBarItem);

	function startPolling() {
		if (intervalId) clearInterval(intervalId);
		intervalId = setInterval(pollAndDisplayRateLimit, pollInterval * 1000);
	}

	startPolling();

	const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('githubRateLimit.pollIntervalSeconds')) {
			pollInterval = vscode.workspace.getConfiguration('githubRateLimit').get<number>('pollIntervalSeconds', 1);
			startPolling();
		}
	});
	subscriptions.push(configChangeDisposable);

	// Register command for showing the graph and wire status bar click to it
	subscriptions.push(vscode.commands.registerCommand('githubRateLimit.showGraph', () => {
		showRateLimitGraph();
	}));
	myStatusBarItem.command = 'githubRateLimit.showGraph';

	subscriptions.push({
		dispose: () => {
			if (intervalId) clearInterval(intervalId);
		}
	});
}

// If set, ignore further rate limit exceed notifications
let ignoreUntil = new Date();
let shown = false
async function pollAndDisplayRateLimit() {
	try {
		const session = await vscode.authentication.getSession('github', ['read:user']);
		if (!session) {
			myStatusBarItem.text = `$(alert) GitHub login required`;
			myStatusBarItem.show();
			return;
		}

		const octokit = new Octokit({ auth: session.accessToken });
		const response = await octokit.request('GET /rate_limit');
		const resources = response.data.resources;

		// Build tooltip with all resource rate limits as a markdown table
		const now = new Date();
		const tableRows: string[] = [
			'| Resource | Left | Reset |',
			'|----------|-----:|------:|'
		];
		for (const [name, info] of Object.entries(resources)) {
			if (typeof info !== 'object' || info === null) continue;
			const remaining = info.remaining;
			const reset = info.reset;
			if (typeof remaining !== 'number' || typeof reset !== 'number') continue;
			const resetDate = new Date(reset * 1000);
			const diffMs = resetDate.getTime() - now.getTime();
			const resetTime = humanizeDuration(diffMs);
			tableRows.push(`| ${name} | ${remaining} | ${resetTime} |`);
		}
		const tooltipText: vscode.MarkdownString = new vscode.MarkdownString(tableRows.join('\n'));

		// Save history in-memory: record remaining value for each resource with timestamp
		try {
			const nowMs = now.getTime();
			const MAX_POINTS = 3600;
			for (const [name, info] of Object.entries(resources)) {
				if (typeof info !== 'object' || info === null) continue;
				const remaining = info.remaining;
				const limit = info.limit;
				if (typeof remaining !== 'number') continue;
				if (typeof limit === 'number') {
					rateLimitLimits[name] = limit;
				}
				if (!rateLimitHistory[name]) rateLimitHistory[name] = [];
				rateLimitHistory[name].push([nowMs, remaining]);
				if (rateLimitHistory[name].length > MAX_POINTS) rateLimitHistory[name].splice(0, rateLimitHistory[name].length - MAX_POINTS);
			}

			// Notify webview if visible
			if (webviewPanel) {
				webviewPanel.webview.postMessage({ type: 'update', history: rateLimitHistory, limits: rateLimitLimits });
			}
		} catch (e) {
			console.error('Failed to save in-memory rate limit history', e);
		}

		// Use core as the main status bar value
		const core = resources.core;
		const remaining = core?.remaining?.toString() ?? '?';
		const reset = core?.reset;
		let resetDate: Date | undefined;
		let resetTime = '';
		if (typeof reset === 'number') {
			resetDate = new Date(reset * 1000);
			const diffMs = resetDate.getTime() - now.getTime();
			resetTime = humanizeDuration(diffMs);
		}


		if (remaining === '0') {
			if (!exceededDate) {
				exceededDate = now;
			}
			myStatusBarItem.text = `$(github) Reset: ${resetTime}`;
			myStatusBarItem.tooltip = `GitHub Rate limit exceeded at or before ${exceededDate.toLocaleTimeString()}! Resets at ${resetDate?.toLocaleTimeString()}` + '\n' + tooltipText;
			myStatusBarItem.color = 'red';

			if (ignoreUntil < now) {
				vscode.window.showWarningMessage(`GitHub Rate limit exceeded! Resets at: ${resetTime}`);
			}

			// Set ignoreUntil to the next reset time plus a buffer of 1 minute
			ignoreUntil = new Date((resetDate?.getTime() ?? now.getTime()) + 60000);
		} else {
			if (exceededDate) {
				exceededDate = undefined; // Reset exceeded date if we are back to normal
			}
			myStatusBarItem.text = `$(github) ${remaining}`;
			myStatusBarItem.color = undefined;
			myStatusBarItem.tooltip = tooltipText;
		}
	} catch (err: any) {
		myStatusBarItem.text = `$(github) Error: ${err.message}`;
	}
	if (!shown) {
		myStatusBarItem.show();
		shown = true;
	}
}

// Humanize duration in ms to a friendly string (e.g., "in 1 hour and 5 minutes")
function humanizeDuration(ms: number): string {
	if (ms <= 0) return 'now';
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m`;
	return `${seconds}s`;
}

function showRateLimitGraph() {
		if (!extensionContext) return;
		if (webviewPanel) {
				webviewPanel.reveal(vscode.ViewColumn.One);
				return;
		}

		webviewPanel = vscode.window.createWebviewPanel(
				'githubRateLimitGraph',
				'GitHub Rate Limit History',
				vscode.ViewColumn.One,
				{ enableScripts: true }
		);

		webviewPanel.webview.html = getWebviewContent(webviewPanel.webview);

		// Send initial in-memory history and limits
		webviewPanel.webview.postMessage({ type: 'init', history: rateLimitHistory, limits: rateLimitLimits });

		webviewPanel.onDidDispose(() => {
				webviewPanel = undefined;
		}, null, extensionContext.subscriptions);
}

function getWebviewContent(webview: vscode.Webview) {
		const cspSource = webview.cspSource;
		// Use Chart.js from CDN
		const chartJs = 'https://cdn.jsdelivr.net/npm/chart.js';

		return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; script-src ${cspSource} https://cdn.jsdelivr.net 'unsafe-inline'; style-src ${cspSource} 'unsafe-inline' https:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>GitHub Rate Limit History</title>
</head>
<body>
 	<div id="chart-container"><canvas id="chart"></canvas></div>
	<script src="${chartJs}"></script>
	<script>
		const vscodeApi = acquireVsCodeApi();
		let history = {};
		let visibility = {};
		let limits = {};
		let chart;

		function buildDatasetsAndLabels() {
			// build label set (timestamps) unioned and sorted
			const tsSet = new Set();
			for (const k of Object.keys(history)) {
				for (const [ts] of history[k]) tsSet.add(ts);
			}
			const labels = Array.from(tsSet).sort((a,b)=>a-b).map(t => new Date(t).toLocaleTimeString());
			const tsIndex = Array.from(tsSet).sort((a,b)=>a-b).map(t => t);

			const datasets = [];
			const palette = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#64748b'];
			const keys = Object.keys(history).sort((a,b) => {
				if (a === 'core') return -1;
				if (b === 'core') return 1;
				return a.localeCompare(b);
			});
			for (let i = 0; i < keys.length; i++) {
				const k = keys[i];
				const map = new Map(history[k].map(([t,v]) => [t, v]));
				const data = tsIndex.map(t => map.has(t) ? map.get(t) : null);
				const isCore = (k === 'core');
				const hidden = (k in visibility) ? visibility[k] : !isCore;
				const color = palette[i % palette.length];
				// main dataset
				datasets.push({ label: k, data, spanGaps: true, tension: 0.0, hidden, borderColor: color, backgroundColor: color + '33', borderWidth: 2, pointStyle: 'rect', pointBackgroundColor: color, pointRadius: 2 });
				// limit dataset (dotted horizontal line) if available
				const lim = (limits && (k in limits)) ? limits[k] : null;
				if (typeof lim === 'number') {
					const limData = tsIndex.map(_ => lim);
					datasets.push({ label: k + ' limit', data: limData, borderColor: color, borderDash: [6,4], borderWidth: 1, pointRadius: 0, fill: false, tension: 0, hidden: hidden });
				}
			}
			return { labels, datasets };
		}

		function createChart() {
			const ctx = document.getElementById('chart').getContext('2d');
			const cfg = {
				type: 'line',
				data: { labels: [], datasets: [] },
				options: {
					responsive: true,
					maintainAspectRatio: true,
					animation: false,
					interaction: { mode: 'index', intersect: false },
					scales: { x: { display: true }, y: { display: true, beginAtZero: true } },
					plugins: {
						legend: {
							position: 'right',
							align: 'center',
							labels: { boxWidth: 12, usePointStyle: true, filter: function(item) { return !item.text.endsWith(' limit'); } },
							onClick: function(e, legendItem, legend) {
								const index = legendItem.datasetIndex;
								const ci = legend.chart;
								const ds = ci.data.datasets[index];
								// toggle main dataset
								ds.hidden = !ds.hidden;
								// also toggle corresponding limit dataset (if next dataset is a limit for this label)
								const next = ci.data.datasets[index + 1];
								if (next && typeof next.label === 'string' && next.label === ds.label + ' limit') {
									next.hidden = ds.hidden;
								}
								// record visibility so it persists across updates
								visibility[ds.label] = !!ds.hidden;
								ci.update();
							}
						}
					}
				}
			};
			chart = new Chart(ctx, cfg);
		}

		function updateChart() {
			if (!chart) createChart();
			const { labels, datasets } = buildDatasetsAndLabels();
			chart.data.labels = labels;
			chart.data.datasets = datasets;
			chart.update();
		}

		window.addEventListener('message', event => {
			const msg = event.data;
			if (msg.type === 'init' || msg.type === 'update') {
				history = msg.history || {};
				limits = msg.limits || {};
				// ensure visibility has entries for current keys, preserving existing values
				for (const k of Object.keys(history)) {
					if (!(k in visibility)) visibility[k] = (k === 'core') ? false : true;
				}
				updateChart();
			}
		});

	</script>
</body>
</html>`;
}