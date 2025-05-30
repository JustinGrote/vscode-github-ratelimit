/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/


import * as vscode from 'vscode';
import { Octokit } from '@octokit/core';

let myStatusBarItem: vscode.StatusBarItem;
let intervalId: ReturnType<typeof setInterval> | undefined;
let exceededDate: Date | undefined;

export async function activate({ subscriptions }: vscode.ExtensionContext) {
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

	subscriptions.push({
		dispose: () => {
			if (intervalId) clearInterval(intervalId);
		}
	});
}

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
		const headers = response.headers;
		const remaining = headers['x-ratelimit-remaining'];
		const reset = headers['x-ratelimit-reset'];

		if (!reset) {
			throw new Error('Invalid reset time from GitHub API');
		}
		const resetDate = new Date(Number(reset) * 1000);
		const now = new Date();
		const diffMs = resetDate.getTime() - now.getTime();
		const resetTime = humanizeDuration(diffMs);

		myStatusBarItem.tooltip = `GitHub Rate limit remaining: ${remaining}`;
		if (remaining === '0') {
			if (!exceededDate) {
				exceededDate = now;
			}
			myStatusBarItem.text = `$(github) Reset: ${resetTime}`;
			myStatusBarItem.tooltip = `GitHub Rate limit exceeded at or before ${exceededDate.toLocaleTimeString()}! Resets at ${resetDate.toLocaleTimeString()}`;
			myStatusBarItem.color = 'red';
			vscode.window.showWarningMessage(`$(alert) GitHub Rate limit exceeded! Resets at: ${resetTime}`);
		} else {
			if (exceededDate) {
				exceededDate = undefined; // Reset exceeded date if we are back to normal
			}
			myStatusBarItem.text = `$(github) ${remaining}`;
			myStatusBarItem.color = undefined;
			myStatusBarItem.tooltip = `Rate limit resets at ${resetDate.toLocaleTimeString()} (${resetTime})`;
		}
	} catch (err: any) {
		myStatusBarItem.text = `$(github) Error: ${err.message}`;
	}
	myStatusBarItem.show();
}

// Humanize duration in ms to a friendly string (e.g., "in 1 hour and 5 minutes")
function humanizeDuration(ms: number): string {
	if (ms <= 0) return 'now';
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) return `${minutes}m`
	return `${seconds}s`
}