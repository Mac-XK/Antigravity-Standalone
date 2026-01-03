import * as vscode from 'vscode';
import { DataManager, Account } from './services/DataManager';
import { GeminiClient } from './services/GeminiClient';

export class AccountWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'antigravity-accounts-webview';
    private _view?: vscode.WebviewView;
    private _onDidChangeAccountData = new vscode.EventEmitter<void>();
    public readonly onDidChangeAccountData = this._onDidChangeAccountData.event;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private dataManager: DataManager,
        private geminiClient: GeminiClient
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
            switch (data.type) {
                case 'ready':
                    {
                        await this.refresh();
                        break;
                    }
                case 'switchAccount':
                    {
                        const accountId = data.value;
                        // 触发深度切换命令
                        vscode.commands.executeCommand('antigravity.switchAccount', accountId);
                        break;
                    }
                case 'addAccount':
                    {
                        this.navigateToAddAccount();
                        break;
                    }
                case 'refresh':
                    {
                        await this.refreshAllQuotas();
                        break;
                    }
            }
        });

        // 监听可见性变更（折叠/展开）时刷新
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refresh();
            }
        });

        // 初始化加载
        // 即使有 ready 信号，这里也先尝试刷新一次以防万一
        this.refresh();
    }

    public async refresh() {
        if (!this._view) return;
        const index = await this.dataManager.loadAccountIndex();
        const accounts = await this.dataManager.getAllAccounts();

        this._view.webview.postMessage({
            type: 'update',
            accounts: accounts,
            currentAccountId: index.current_account_id
        });
        this._onDidChangeAccountData.fire();
    }

    public async refreshAllQuotas() {
        const accounts = await this.dataManager.getAllAccounts();

        // 在 VS Code 界面显示进度
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
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'vscode.css'));

        // 内联 CSS / HTML 构建
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Antigravity Accounts</title>
            <style>
                :root {
                    --container-paddding: 20px;
                    --input-padding-vertical: 6px;
                    --input-padding-horizontal: 4px;
                    --input-margin-vertical: 4px;
                    --input-margin-horizontal: 0;
                }

                body {
                    padding: 10px;
                    color: var(--vscode-foreground);
                    font-family: var(--vscode-font-family);
                    background-color: transparent;
                }

                .card {
                    background-color: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-widget-border);
                    border-radius: 8px;
                    padding: 12px;
                    margin-bottom: 12px;
                    transition: all 0.2s ease;
                    position: relative;
                    cursor: pointer;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .card:hover {
                    background-color: var(--vscode-list-hoverBackground);
                    transform: translateY(-2px);
                    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
                }

                .card.active {
                    border: 1px solid var(--vscode-focusBorder);
                    background-color: var(--vscode-list-activeSelectionBackground);
                    color: var(--vscode-list-activeSelectionForeground);
                }

                .header {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .avatar-wrapper {
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .avatar-img {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    object-fit: cover;
                }

                .avatar-text {
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    color: white;
                    font-size: 14px;
                }
                
                .info {
                    flex: 1;
                    overflow: hidden;
                }

                .email {
                    font-weight: 600;
                    font-size: 13px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                .status {
                    font-size: 11px;
                    opacity: 0.8;
                    margin-top: 2px;
                }

                .quota-container {
                    margin-top: 8px;
                }

                .progress-bar-bg {
                    height: 6px;
                    background-color: var(--vscode-progressBar-background);
                    border-radius: 3px;
                    overflow: hidden;
                    opacity: 0.3;
                }

                .progress-bar-fill {
                    height: 100%;
                    background-color: #4caf50;
                    border-radius: 3px;
                    transition: width 0.5s ease;
                }

                .quota-text {
                    font-size: 10px;
                    display: flex;
                    justify-content: space-between;
                    margin-top: 4px;
                    opacity: 0.7;
                }

                .models-grid {
                    margin-top: 10px;
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                    border-top: 1px solid var(--vscode-widget-border);
                    padding-top: 8px;
                }

                .model-summary-item {
                    display: flex;
                    align-items: center;
                    font-size: 11px;
                    gap: 4px;
                    background-color: var(--vscode-textBlockQuote-background);
                    padding: 2px 6px;
                    border-radius: 4px;
                }
                
                .model-icon {
                    font-size: 10px;
                }

                .model-name {
                    font-weight: 500;
                    opacity: 0.9;
                }

                .model-val {
                    opacity: 0.8;
                    font-weight: bold;
                }

                .fab {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    width: 50px;
                    height: 50px;
                    border-radius: 25px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 24px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                    cursor: pointer;
                    transition: all 0.2s;
                    border: none;
                    z-index: 100;
                }
                
                .fab:hover {
                    background-color: var(--vscode-button-hoverBackground);
                    transform: scale(1.1);
                }

                .empty-state {
                    text-align: center;
                    padding: 40px 10px;
                    opacity: 0.7;
                }

                /* 激活状态微标 */
                .badge {
                    background-color: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-size: 10px;
                    position: absolute;
                    top: 10px;
                    right: 10px;
                }
            </style>
        </head>
        <body>
            <div id="accounts-list"></div>
            
            <button class="fab" id="add-btn" title="添加账号">+</button>

            <script>
                const vscode = acquireVsCodeApi();
                const list = document.getElementById('accounts-list');
                const addBtn = document.getElementById('add-btn');

                addBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'addAccount' });
                });

                // 通知插件 Webview 已就绪（处理重载/显隐）
                vscode.postMessage({ type: 'ready' });

                // 处理来自插件的消息
                window.addEventListener('message', event => {
                    const message = event.data;
                    switch (message.type) {
                        case 'update':
                            renderAccounts(message.accounts, message.currentAccountId);
                            break;
                    }
                });

                function renderAccounts(accounts, currentId) {
                    list.innerHTML = '';
                    
                    if (!accounts || accounts.length === 0) {
                        list.innerHTML = '<div class="empty-state">暂无账号<br>点击右下角 + 添加</div>';
                        return;
                    }

                    accounts.forEach(acc => {
                        const isActive = acc.id === currentId;
                        const el = document.createElement('div');
                        el.className = 'card' + (isActive ? ' active' : '');
                        el.onclick = () => {
                            if (!isActive) {
                                vscode.postMessage({ type: 'switchAccount', value: acc.id });
                            }
                        };

                        const initial = acc.email ? acc.email[0].toUpperCase() : '?';
                        const avatarHtml = acc.picture 
                            ? \`<img src="\${acc.picture}" class="avatar-img">\` 
                            : \`<div class="avatar-text">\${initial}</div>\`;

                        const quota = acc.quota?.remaining_quota ?? 0;
                        const forbidden = acc.quota?.is_forbidden;
                        
                        let statusText = isActive ? '当前使用中' : '点击切换';
                        let progressColor = '#4caf50';
                        
                        if (forbidden) {
                            statusText = '账号异常 (403)';
                            progressColor = '#f44336';
                        } else if (quota < 10) {
                            progressColor = '#f44336'; // Red for low quota
                        } else if (quota < 30) {
                            progressColor = '#ff9800'; // Orange for medium
                        }

                        el.innerHTML = \`
                            \${isActive ? '<div class="badge">ACTIVE</div>' : ''}
                            <div class="header">
                                <div class="avatar-wrapper">\${avatarHtml}</div>
                                <div class="info">
                                    <div class="email" title="\${acc.email}">\${acc.email}</div>
                                    <div class="status">\${statusText}</div>
                                </div>
                            </div>
                            <div class="quota-container">
                                <div class="progress-bar-bg" style="background-color: \${isActive ? 'rgba(255,255,255,0.2)' : ''}">
                                    <div class="progress-bar-fill" style="width: \${quota}%; background-color: \${progressColor}"></div>
                                </div>
                                <div class="quota-text">
                                    <span>可用配额 (最低)</span>
                                    <span>\${quota}%</span>
                                </div>
                                <div class="models-grid">
                                    \${renderModelSummary(acc.quota?.models)}
                                </div>
                            </div>
                        \`;
                        list.appendChild(el);
                    });
                }

                function renderModelSummary(models) {
                    if (!models) return '';
                    
                    const getMin = (keyword) => {
                         let min = null;
                         let reset = null;
                         for (const k in models) {
                             if (k.toLowerCase().includes(keyword)) {
                                 const p = models[k].percentage;
                                 if (min === null || p < min) {
                                     min = p;
                                     reset = models[k].reset_time;
                                 }
                             }
                         }
                         return { val: min, reset };
                    };

                    const claude = getMin('claude');
                    const pro = getMin('pro'); // Covers gemini pro
                    const flash = getMin('flash'); // Covers gemini flash

                    const items = [];
                    const getIcon = (p) => p >= 50 ? '🟢' : (p >= 30 ? '🟡' : '🔴');
                    
                    const formatTime = (t) => {
                        if (!t) return '';
                        try {
                            const date = new Date(t);
                            const now = new Date();
                            const diffMs = date.getTime() - now.getTime();
                            
                            if (diffMs <= 0) return ''; // Already passed
                            
                            const diffMins = Math.ceil(diffMs / 60000);
                            const h = Math.floor(diffMins / 60);
                            const m = diffMins % 60;
                            
                            // Format: 1h 5m
                            if (h > 0) return \`\${h}h \${m}m\`;
                            return \`\${m}m\`;
                        } catch (e) { return ''; }
                    };

                    // 仅在值小于100时显示重置时间
                    
                    const mkItem = (name, data) => {
                        if (data.val !== null) {
                            const timeStr = (data.val < 100 && data.reset) ? \`(\${formatTime(data.reset)})\` : '';
                            items.push({
                                name: name, 
                                val: data.val, 
                                icon: getIcon(data.val),
                                time: timeStr
                            });
                        }
                    };

                    mkItem('Claude', claude);
                    mkItem('G Pro', pro);
                    mkItem('G Flash', flash);

                    return items.map(item => \`
                        <div class="model-summary-item" title="Resets at \${item.time}">
                            <span class="model-icon">\${item.icon}</span>
                            <span class="model-name">\${item.name}</span>
                            <span class="model-val">\${item.val}% \${item.time}</span>
                        </div>
                    \`).join('');
                }
            </script>
        </body>
        </html>`;
    }
}
