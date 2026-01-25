import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DataManager, Account } from './services/DataManager';
import { GeminiClient } from './services/GeminiClient';
import { TriggerService } from './services/TriggerService';
import { SchedulerService, ScheduleConfig } from './services/SchedulerService';

export class AccountWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravity-accounts-webview';
    private _view?: vscode.WebviewView;
    private _onDidChangeAccountData = new vscode.EventEmitter<void>();
    public readonly onDidChangeAccountData = this._onDidChangeAccountData.event;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private dataManager: DataManager,
        private geminiClient: GeminiClient,
        private triggerService: TriggerService,
        private schedulerService: SchedulerService
    ) { }

    public navigateToAddAccount() {
        vscode.commands.executeCommand('antigravity.addAccount');
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command || data.type) { // Support both formats
                case 'ready':
                case 'autoTrigger.getState':
                    await this.refresh();
                    break;
                case 'switchAccount':
                    vscode.commands.executeCommand('antigravity.switchAccount', data.value);
                    break;
                case 'addAccount':
                    this.navigateToAddAccount();
                    break;
                case 'refresh':
                    await this.refreshAllQuotas();
                    break;
                case 'autoTrigger.saveSchedule':
                    await this.schedulerService.setSchedule(data.schedule, async () => {
                        await this.triggerService.trigger(undefined, 'auto');
                    });
                    await this.refresh();
                    break;
                case 'autoTrigger.test':
                    await this.handleTestTrigger(data.models, data.accounts, data.customPrompt);
                    break;
                case 'autoTrigger.clearHistory':
                    await this.triggerService.clearHistory();
                    await this.refresh();
                    break;
                case 'autoTrigger.toggle': // Simple toggle fallback
                    // Logic handled in saveSchedule usually
                    break;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refresh();
            }
        });

        // Initial load
        this.refresh();
    }

    private async handleTestTrigger(models?: string[], accounts?: string[], customPrompt?: string) {
        try {
            const res = await this.triggerService.trigger(undefined, 'manual');
            // Send state update to refresh UI
            await this.refresh();
            vscode.window.showInformationMessage(`唤醒成功: ${res.message}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`唤醒失败: ${e.message}`);
        }
    }

    public async refresh() {
        if (!this._view) return;
        const index = await this.dataManager.loadAccountIndex();
        const accounts = await this.dataManager.getAllAccounts();
        const schedule = this.schedulerService.getSchedule() || { enabled: false, repeatMode: 'daily' };

        // Extract available models from quota data
        const modelSet = new Set<string>();
        for (const acc of accounts) {
            if (acc.quota?.models) {
                Object.keys(acc.quota.models).forEach(modelId => modelSet.add(modelId));
            }
        }
        const availableModels = Array.from(modelSet)
            .filter(id => !id.includes('2.5')) // Filter out 2.5 models
            .sort()
            .map(id => ({
                id,
                displayName: this.formatModelName(id)
            }));

        // Construct AutoTrigger State
        const autoTriggerState = {
            schedule: {
                ...schedule,
                selectedModels: schedule.selectedModels || (availableModels[0]?.id ? [availableModels[0].id] : []), // Default to first available
            },
            availableModels,
            authorization: {
                isAuthorized: accounts.length > 0,
                accounts: accounts.map(a => ({ email: a.email })),
                activeAccount: accounts.find(a => a.id === index.current_account_id)?.email
            },
            nextTriggerTime: this.schedulerService.getNextRunTime()?.toISOString(),
            recentTriggers: this.triggerService.getHistory()
        };

        // Send 2 messages: 1 for standard UI, 1 for AutoTrigger JS
        this._view.webview.postMessage({
            type: 'update', // For my custom script
            accounts: accounts,
            currentAccountId: index.current_account_id
        });

        this._view.webview.postMessage({
            type: 'autoTriggerState', // For auto_trigger.js
            data: autoTriggerState
        });

        this._onDidChangeAccountData.fire();
    }

    private formatModelName(modelId: string): string {
        // Format model ID into readable display name
        const lc = modelId.toLowerCase();
        if (lc.includes('claude')) {
            return modelId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }
        if (lc.includes('flash') && lc.includes('thinking')) return 'Gemini Flash (Thinking)';
        if (lc.includes('flash')) return 'Gemini Flash';
        if (lc.includes('pro') && lc.includes('image') && lc.includes('high')) return 'Gemini Pro Image (High)';
        if (lc.includes('pro') && lc.includes('image') && lc.includes('low')) return 'Gemini Pro Image (Low)';
        if (lc.includes('pro') && lc.includes('image')) return 'Gemini Pro Image';
        if (lc.includes('pro') && lc.includes('high')) return 'Gemini Pro (High)';
        if (lc.includes('pro') && lc.includes('low')) return 'Gemini Pro (Low)';
        if (lc.includes('pro')) return 'Gemini Pro';
        // Fallback: capitalize and replace dashes with dots for version numbers
        return modelId
            .replace(/-/g, ' ')
            .replace(/(\d) (\d)/g, '$1.$2')
            .replace(/\b\w/g, c => c.toUpperCase());
    }

    public async refreshAllQuotas() {
        const accounts = await this.dataManager.getAllAccounts();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Refreshing Quotas...",
            cancellable: false
        }, async (progress) => {
            const increment = 100 / accounts.length;
            for (const acc of accounts) {
                const quota = await this.geminiClient.fetchQuota(acc);
                if (quota) {
                    acc.quota = quota;
                    await this.dataManager.saveAccount(acc);
                }
                progress.report({ increment });
            }
        });
        this.refresh();
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const extensionUri = this._extensionUri;

        // Assets
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'dashboard.css'));
        const autoTriggerStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'auto_trigger.css'));
        const autoTriggerScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'webview', 'auto_trigger.js'));

        // CSP
        const nonce = getNonce();

        // Translations (Simplified Chinese)
        const i18n: Record<string, string> = {
            "dashboard.title": "控制台",
            "autoTrigger.tabTitle": "自动唤醒",
            "autoTrigger.statusLabel": "状态",
            "autoTrigger.enabled": "已启用",
            "autoTrigger.disabled": "已停用",
            "autoTrigger.modeScheduled": "计划任务",
            "autoTrigger.modeCrontab": "Crontab",
            "autoTrigger.modeQuotaReset": "配额重置",
            "autoTrigger.nextTrigger": "下次运行",
            "autoTrigger.configBtn": "配置",
            "autoTrigger.testBtn": "测试",
            "autoTrigger.historyBtn": "历史",
            "autoTrigger.saveBtn": "保存",
            "autoTrigger.scheduleSection": "计划配置",
            "autoTrigger.enableAutoWakeup": "启用自动唤醒",
            "autoTrigger.customPrompt": "自定义唤醒词",
            "autoTrigger.modelSection": "模型选择",
            "autoTrigger.accountSection": "账号选择",
            "common.cancel": "取消",
            "time.today": "今天",
            "time.tomorrow": "明天",
            // Test modal
            "autoTrigger.runTest": "发送",
            "autoTrigger.testing": "发送中...",
            "autoTrigger.testingPleaseWait": "正在发送唤醒请求，请稍候...",
            // History labels
            "autoTrigger.typeManual": "手动",
            "autoTrigger.typeAuto": "自动",
            "autoTrigger.typeAutoScheduled": "计划任务",
            "autoTrigger.typeAutoCrontab": "Crontab",
            "autoTrigger.typeAutoQuotaReset": "配额重置",
            "autoTrigger.historySuccess": "成功",
            "autoTrigger.historyFailed": "失败",
            "autoTrigger.noHistory": "暂无记录",
            "autoTrigger.clearHistory": "清空历史",
            // Mode display
            "autoTrigger.daily": "每天",
            "autoTrigger.weekly": "每周",
            "autoTrigger.interval": "间隔",
            // Weekday names
            "time.sunday": "周日",
            "time.monday": "周一",
            "time.tuesday": "周二",
            "time.wednesday": "周三",
            "time.thursday": "周四",
            "time.friday": "周五",
            "time.saturday": "周六"
        };

        // Escaped backticks are tricky. We use \` for JS strings inside the HTML string.
        return `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval'; img-src https: data:;">
            <title>Antigravity</title>
            <link rel="stylesheet" href="${styleUri}">
            <link rel="stylesheet" href="${autoTriggerStyleUri}">
            <style>
                /* Override/Fixes for Sidebar Width */
                body { padding: 0; background-color: var(--vscode-sideBar-background); }
                .tab-nav { padding: 0; margin-bottom: 2px; }
                .tab-btn { padding: 10px; font-size: 13px; }
                .card { margin: 8px; padding: 12px; } /* Adjust card margin */
                .status-connecting { font-size: 12px; padding: 20px; text-align: center; opacity: 0.7; }
                
                /* Accounts specific style */
                .account-card {
                    background: var(--vscode-list-hoverBackground);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 8px;
                    padding: 12px;
                    margin: 8px;
                    cursor: pointer;
                    transition: all 0.2s;
                    position: relative;
                }
                .account-card:hover { border-color: var(--vscode-focusBorder); transform: translateY(-1px); }
                .account-card.active { 
                    background: var(--vscode-list-activeSelectionBackground); 
                    color: var(--vscode-list-activeSelectionForeground);
                    border-color: var(--vscode-focusBorder);
                }
                
                .acc-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
                .acc-avatar { 
                    width: 32px; height: 32px; border-radius: 50%; 
                    background: linear-gradient(135deg, #667eea, #764ba2); 
                    display: flex; align-items: center; justify-content: center;
                    font-weight: bold; color: white;
                }
                .acc-info { flex: 1; overflow: hidden; }
                .acc-email { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .acc-badge { font-size: 10px; opacity: 0.8; }
                
                .acc-quota-bar { height: 6px; background: rgba(0,0,0,0.2); border-radius: 3px; overflow: hidden; margin-top: 6px; }
                .acc-quota-fill { height: 100%; transition: width 0.5s; }
                
                .fab-add {
                    position: fixed; bottom: 20px; right: 20px;
                    width: 48px; height: 48px; border-radius: 24px;
                    background: var(--vscode-button-background);
                    color: white; font-size: 24px; border: none;
                    display: flex; align-items: center; justify-content: center;
                    cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3);
                    z-index: 99;
                }
                .fab-add:hover { background: var(--vscode-button-hoverBackground); transform: scale(1.05); }

                /* Hide irrelevant parts from auto_trigger HTML template if any */
                .quota-source-toggle { display: none; }

                /* Isolated Modal Styles */
                .at-modal {
                    position: fixed;
                    z-index: 10000; /* Extremely high to ensure visibility */
                    left: 0;
                    top: 0;
                    width: 100%;
                    height: 100%;
                    overflow: hidden;
                    background-color: rgba(0, 0, 0, 0.5);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    backdrop-filter: blur(2px);
                    transition: opacity 0.2s ease, visibility 0.2s ease;
                    opacity: 1;
                    visibility: visible;
                }

                .at-modal.at-hidden {
                    opacity: 0;
                    visibility: hidden;
                    pointer-events: none;
                    display: none !important; /* Force hide to be safe */
                }

                .at-modal-content {
                    background-color: var(--vscode-editor-background);
                    margin: auto;
                    padding: 0;
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 8px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                    width: 90%;
                    max-width: 600px;
                    display: flex;
                    flex-direction: column;
                    max-height: 85vh;
                    animation: atModalSlideIn 0.2s ease-out;
                    position: relative;
                }

                @keyframes atModalSlideIn {
                    from { opacity: 0; transform: translateY(20px) scale(0.98); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }

                .at-modal-header {
                    padding: 16px 20px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .at-modal-header h3 { margin: 0; font-size: 16px; font-weight: 600; }

                .at-close-btn {
                    color: var(--vscode-descriptionForeground);
                    font-size: 24px;
                    font-weight: bold;
                    background: none;
                    border: none;
                    cursor: pointer;
                    line-height: 1;
                    padding: 0 4px;
                }
                .at-close-btn:hover { color: var(--vscode-foreground); }

                .at-modal-body { padding: 20px; overflow-y: auto; flex: 1; }
                
                .at-modal-footer {
                    padding: 16px 20px;
                    border-top: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: flex-end;
                    gap: 12px;
                }

                /* History badge */
                .at-badge {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-width: 18px;
                    height: 18px;
                    padding: 0 5px;
                    font-size: 11px;
                    font-weight: 600;
                    background: var(--vscode-badge-background, #007acc);
                    color: var(--vscode-badge-foreground, #fff);
                    border-radius: 9px;
                    margin-left: 4px;
                }
            </style>
        </head>
        <body>
            <!-- Tab Navigation -->
            <nav class="tab-nav">
                <button class="tab-btn active" data-tab="accounts">👥 账号列表</button>
                <button class="tab-btn" data-tab="auto-trigger">
                    ⚡ 自动唤醒 <span id="at-tab-status-dot" class="status-dot hidden">●</span>
                </button>
            </nav>

            <!-- Accounts Tab -->
            <div id="tab-accounts" class="tab-content active">
                <div id="accounts-list">
                    <div class="status-connecting">加载中...</div>
                </div>
                <button class="fab-add" id="add-account-btn" title="添加账号">+</button>
            </div>

            <!-- Auto Trigger Tab -->
            <div id="tab-auto-trigger" class="tab-content">
                <div class="auto-trigger-compact">
                    <div class="at-status-card" id="at-status-card">
                        <div class="at-status-grid" id="at-status-grid">
                            <div class="at-status-item">
                                <span class="at-label">⏰ 状态</span>
                                <span class="at-value" id="at-status-value">已停用</span>
                            </div>
                            <div class="at-status-item">
                                <span class="at-label">📅 模式</span>
                                <span class="at-value" id="at-mode-value">--</span>
                            </div>
                            <div class="at-status-item">
                                <span class="at-label">⏭️ 下次运行</span>
                                <span class="at-value" id="at-next-value">--</span>
                            </div>
                        </div>
                        <div class="at-actions" id="at-actions">
                            <button id="at-config-btn" class="at-btn at-btn-secondary">⚙️ 配置</button>
                            <button id="at-test-btn" class="at-btn at-btn-accent">⚡ 测试</button>
                            <button id="at-history-btn" class="at-btn at-btn-secondary">📜 历史 <span id="at-history-badge" class="at-badge at-hidden"></span></button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Configuration Modals (Hidden) -->
            <div id="at-config-modal" class="at-modal at-hidden">
                <div class="at-modal-content modal-content-medium">
                    <div class="at-modal-header">
                        <h3>计划配置</h3>
                        <button id="at-config-close" class="at-close-btn">×</button>
                    </div>
                    <div class="at-modal-body at-config-body">
                         <div class="at-config-row">
                            <label>启用自动唤醒</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="at-enable-schedule">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div id="at-wakeup-config-body">
                             <!-- Repeat Mode -->
                             <div class="at-config-section">
                                <label>重复模式</label>
                                <select id="at-mode-select" class="at-select">
                                    <option value="daily">每天</option>
                                    <option value="interval">间隔循环</option>
                                    <option value="weekly">每周</option>
                                </select>
                             </div>
                             
                             <div id="at-config-daily" class="at-mode-config">
                                <label>选择时间</label>
                                <div class="at-time-grid" id="at-daily-times"><!-- filled by JS --></div>
                                <div class="at-custom-time-row">
                                    <input type="time" id="at-daily-custom-time" class="at-input-time">
                                    <button id="at-daily-add-time" class="at-btn at-btn-secondary">添加</button>
                                </div>
                             </div>

                             <div id="at-config-interval" class="at-mode-config hidden">
                                <div class="at-interval-row">
                                    <label>每隔(小时)</label>
                                    <input type="number" id="at-interval-hours" min="1" max="12" value="4" class="at-input-small">
                                </div>
                             </div>
                             
                             <!-- 自定义唤醒词 -->
                             <div class="at-config-section">
                                <label>唤醒词 (留空默认 hi)</label>
                                <input type="text" id="at-custom-prompt" class="at-input" placeholder="hi">
                             </div>

                             <!-- 模型选择 -->
                             <div class="at-config-section">
                                <label>唤醒模型</label>
                                <div id="at-config-models" class="at-model-list"></div>
                             </div>

                             <!-- 账号选择 -->
                             <div class="at-config-section">
                                <label>唤醒账号</label>
                                <div id="at-config-accounts" class="at-model-list"></div>
                             </div>
                        </div>
                    </div>
                     <div class="at-modal-footer">
                        <button id="at-config-cancel" class="btn-secondary">取消</button>
                        <button id="at-config-save" class="btn-primary">保存</button>
                    </div>
                </div>
            </div>

            <!-- Test Modal -->
            <div id="at-test-modal" class="at-modal at-hidden">
                <div class="at-modal-content modal-content-medium">
                    <div class="at-modal-header">
                        <h3>测试唤醒</h3>
                        <button id="at-test-close" class="at-close-btn">×</button>
                    </div>
                    <div class="at-modal-body">
                        <div class="at-config-section">
                            <label>唤醒词 (留空默认 hi)</label>
                            <input type="text" id="at-test-custom-prompt" class="at-input" placeholder="hi">
                        </div>
                        <div class="at-config-section">
                            <label>选择模型</label>
                            <div id="at-test-models" class="at-model-list"></div>
                        </div>
                        <div class="at-config-section">
                            <label>选择账号</label>
                            <div id="at-test-accounts" class="at-model-list"></div>
                        </div>
                    </div>
                    <div class="at-modal-footer">
                        <button id="at-test-cancel" class="btn-secondary">取消</button>
                        <button id="at-test-run" class="btn-primary">发送</button>
                    </div>
                </div>
            </div>

            <!-- History Modal -->
            <div id="at-history-modal" class="at-modal at-hidden">
                <div class="at-modal-content modal-content-medium">
                    <div class="at-modal-header">
                        <h3>触发历史 <span id="at-history-count"></span></h3>
                        <button id="at-history-close" class="at-close-btn">×</button>
                    </div>
                    <div class="at-modal-body">
                        <div id="at-history-list" class="at-history-list">
                            <div class="at-no-data">暂无记录</div>
                        </div>
                    </div>
                    <div class="at-modal-footer">
                        <button id="at-history-clear" class="btn-secondary">清空历史</button>
                    </div>
                </div>
            </div>

            <!-- Scripts -->
            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                window.__vscodeApi = vscode;
                window.__autoTriggerI18n = ${JSON.stringify(i18n)};
            </script>
            <script nonce="${nonce}" src="${autoTriggerScriptUri}"></script>
            <script nonce="${nonce}">
                // Custom Accounts Logic
                const list = document.getElementById('accounts-list');
                const addBtn = document.getElementById('add-account-btn');
                
                // Tabs
                document.querySelectorAll('.tab-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                        btn.classList.add('active');
                        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
                    });
                });

                addBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'addAccount' });
                });

                window.addEventListener('message', event => {
                    const msg = event.data;
                    if (msg.type === 'update') {
                        renderAccounts(msg.accounts, msg.currentAccountId);
                    }
                });
                
                function renderAccounts(accounts, currentId) {
                    list.innerHTML = '';
                    if (!accounts || accounts.length === 0) {
                        list.innerHTML = '<div class="status-connecting">暂无账号，请点击右下角添加</div>';
                        return;
                    }
                    
                    accounts.forEach(acc => {
                        const isActive = acc.id === currentId;
                        const el = document.createElement('div');
                        el.className = 'account-card' + (isActive ? ' active' : '');
                        el.onclick = () => {
                            if (!isActive) vscode.postMessage({ type: 'switchAccount', value: acc.id });
                        };
                        
                        const quota = acc.quota?.remaining_quota ?? 0;
                        const color = quota < 20 ? '#f44336' : (quota <= 50 ? '#ff9800' : '#4caf50');
                        const initial = acc.email ? acc.email[0].toUpperCase() : '?';
                        const avatar = acc.picture ? \`<img src="\${acc.picture}" class="acc-avatar">\` : \`<div class="acc-avatar">\${initial}</div>\`;
                        
                        // Parse models for summary
                        const modelsHtml = renderModelSummary(acc.quota?.models, isActive);

                        el.innerHTML = \`
                            <div class="acc-header">
                                \${avatar}
                                <div class="acc-info">
                                    <div class="acc-email" title="\${acc.email}">\${acc.email}</div>
                                    <div class="acc-badge">\${isActive ? '当前使用中' : '点击切换'}</div>
                                </div>
                            </div>
                            <div class="acc-quota-bar">
                                <div class="acc-quota-fill" style="width: \${quota}%; background: \${color}"></div>
                            </div>
                            <!-- Model Summary Grid -->
                            <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                                \${modelsHtml}
                            </div>
                        \`;
                        list.appendChild(el);
                    });
                }

                function renderModelSummary(models, isActive) {
                    if (!models) return '';

                    const formatName = (key) => {
                        if (key.includes('claude-3-5-sonnet')) return 'Claude 3.5 Sonnet';
                        if (key.includes('claude-3-opus')) return 'Claude 3 Opus';
                        if (key.includes('gemini-1.5-pro')) return 'Gemini 1.5 Pro';
                        if (key.includes('gemini-1.5-flash')) return 'Gemini 1.5 Flash';
                        if (key.includes('gemini-ultra')) return 'Gemini Ultra';
                        
                        // Fallback
                        return key.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase())
                            .replace('Gemini ', '').replace('Claude ', '');
                    };

                    const getIcon = (p) => p > 50 ? '🟢' : (p >= 20 ? '🟡' : '🔴');
                    const mkItem = (name, val, resetTimeStr) => {
                         const displayVal = parseFloat(val).toFixed(2);
                         let timeInfo = '';
                         if (resetTimeStr && isActive) {
                            try {
                                const resetDate = new Date(resetTimeStr);
                                const now = new Date();
                                const diffMs = resetDate.getTime() - now.getTime();
                                if (diffMs > 0) {
                                    const hours = Math.floor(diffMs / (1000 * 60 * 60));
                                    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                                    const absTime = resetDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
                                    // Escaping backticks for JS string inside template string
                                    timeInfo = \` <span style="opacity: 0.6; font-size: 10px; margin-left: 4px;">→ \${hours}h \${mins}m (\${absTime})</span>\`;
                                }
                            } catch (e) {}
                         }

                         return \`<div style="font-size: 11px; background: rgba(255,255,255,0.1); padding: 3px 8px; border-radius: 4px; display: flex; align-items: center; gap: 5px; flex-grow: 1; min-width: 120px;">
                                <span>\${getIcon(val)}</span>
                                <span style="opacity: 0.9; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="\${name}">\${name}</span>
                                <span style="font-weight: bold; white-space: nowrap;">\${displayVal}%\${timeInfo}</span>
                            </div>\`;
                    };

                    // Filter and Sort
                    const keys = Object.keys(models)
                        .filter(k => !k.includes('2.5')) // Hide 2.5 models
                        .sort((a, b) => {
                            // Custom sort: Put 'Pro Image' at the bottom
                            const isImageA = a.toLowerCase().includes('image');
                            const isImageB = b.toLowerCase().includes('image');
                            if (isImageA && !isImageB) return 1;
                            if (!isImageA && isImageB) return -1;
                            
                            // Default alphabetical sort
                            return a.localeCompare(b);
                        });

                    if (keys.length === 0) return '<span style="opacity:0.5; font-size:11px;">无模型数据</span>';

                    return keys.map(k => {
                        const val = models[k].percentage;
                        const reset = models[k].reset_time;
                        const name = formatName(k);
                        return mkItem(name, val, reset);
                    }).join('');
                }
                
                // Initialize
                vscode.postMessage({ type: 'ready' });
            </script>
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
