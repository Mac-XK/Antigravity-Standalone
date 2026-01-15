
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DataManager } from '../services/DataManager';
import { TriggerService } from '../services/TriggerService';
import { SchedulerService, ScheduleConfig } from '../services/SchedulerService';
import { t, i18n } from '../utils';

export class DashboardController {
    public static readonly viewType = 'antigravity.cockpit';
    private panel?: vscode.WebviewPanel;

    constructor(
        private context: vscode.ExtensionContext,
        private dataManager: DataManager,
        private triggerService: TriggerService,
        private schedulerService: SchedulerService
    ) { }

    public openDashboard() {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (this.panel) {
            this.panel.reveal(column);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            DashboardController.viewType,
            'Antigravity Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'resources'))],
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getHtml(this.panel.webview);
        this.panel.onDidDispose(() => this.panel = undefined, null, this.context.subscriptions);

        this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));

        // Initial Refresh
        this.broadcastRefresh();
    }

    private async handleMessage(message: any) {
        switch (message.command) {
            case 'init':
            case 'refresh':
                await this.broadcastRefresh();
                break;
            case 'testTrigger':
                // Trigger test logic
                try {
                    const res = await this.triggerService.trigger(undefined, 'manual');
                    this.panel?.webview.postMessage({ type: 'triggerResult', success: true, data: res });
                } catch (e: any) {
                    this.panel?.webview.postMessage({ type: 'triggerResult', success: false, error: e.message });
                }
                break;
            // Add more handlers as needed for config saving etc.
        }
    }

    private async broadcastRefresh() {
        if (!this.panel) return;

        const accounts = await this.dataManager.getAllAccounts();
        const config = vscode.workspace.getConfiguration('antigravity');

        // Construct snapshot data compatible with dashboard.js
        // We might need to map some fields
        const snapshot = {
            timestamp: Date.now(),
            isConnected: true,
            // Mocking models data for dashboard visualization from first account for now
            // Ideally we need to aggregate or show a specific view
            models: [], // Populate this based on account quota
            // ... other fields
        };

        // Populate models from current account
        const idx = await this.dataManager.loadAccountIndex();
        if (idx.current_account_id) {
            const acc = await this.dataManager.loadAccount(idx.current_account_id);
            if (acc && acc.quota && acc.quota.models) {
                // Map quota models to dashboard format
                (snapshot as any).models = Object.entries(acc.quota.models).map(([k, v]: [string, any]) => ({
                    modelId: k,
                    label: k,
                    remainingPercentage: v.percentage,
                    resetTimeDisplay: v.reset_time ? new Date(v.reset_time).toLocaleTimeString() : '-'
                }));
            }
        }

        this.panel.webview.postMessage({
            type: 'telemetry_update',
            data: snapshot,
            config: {
                refreshInterval: config.get('refreshInterval'),
                language: vscode.env.language
            }
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const resourcePath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'webview'));
        const toUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(resourcePath, file));

        const styleUri = toUri('dashboard.css');
        const scriptUri = toUri('dashboard.js');
        const autoTriggerStyleUri = toUri('auto_trigger.css');
        const autoTriggerScriptUri = toUri('auto_trigger.js');
        const authUiScriptUri = toUri('auth_ui.js');

        const nonce = getNonce();

        // Inject simplified HTML structure that dashboard.js expects
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: data:;">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Antigravity Dashboard</title>
    <link rel="stylesheet" href="${styleUri}">
    <link rel="stylesheet" href="${autoTriggerStyleUri}">
</head>
<body>
    <div id="dashboard"></div>
    <!-- Basic structure required by dashboard.js -->
    <header class="header">
        <div class="header-title">
            <span class="icon">🚀</span>
            <span>Dashboard</span>
        </div>
        <div class="controls">
            <button id="refresh-btn" class="refresh-btn">Refresh</button>
        </div>
    </header>

    <nav class="tab-nav">
        <button class="tab-btn active" data-tab="quota">📊 Dashboard</button>
        <button class="tab-btn" data-tab="auto-trigger">⏰ Auto Trigger</button>
    </nav>

    <div id="tab-quota" class="tab-content active">
         <!-- dashboard.js will inject content here -->
    </div>

    <div id="tab-auto-trigger" class="tab-content">
         <!-- Auto trigger content -->
         <div class="auto-trigger-compact">
            <div class="at-status-card">
                 <div class="at-actions">
                    <button id="at-test-btn" class="at-btn at-btn-accent">Test Trigger</button>
                 </div>
            </div>
         </div>
    </div>

    <!-- Modals -->
    <div id="settings-modal" class="modal hidden"></div>
    <div id="toast" class="toast hidden"></div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
    <script nonce="${nonce}" src="${autoTriggerScriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
