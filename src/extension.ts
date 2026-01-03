import * as vscode from 'vscode';
import { DataManager, Account } from './services/DataManager';
import { GeminiClient } from './services/GeminiClient';
import { AuthService } from './services/AuthService';
import { AccountWebviewProvider } from './AccountWebviewProvider';
import { AntigravityAuthenticationProvider } from './AuthenticationProvider';
import { StateInjector } from './services/StateInjector';

export async function activate(context: vscode.ExtensionContext) {


    const dataManager = new DataManager();
    const geminiClient = new GeminiClient();
    const authService = new AuthService(dataManager);

    const stateInjector = new StateInjector(context);

    // 注册身份验证提供者
    const authProvider = new AntigravityAuthenticationProvider(context, dataManager);
    context.subscriptions.push(
        vscode.authentication.registerAuthenticationProvider(
            'antigravity',
            'Antigravity',
            authProvider
        )
    );

    // 注册 Webview 提供者
    const webviewProvider = new AccountWebviewProvider(context.extensionUri, dataManager, geminiClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AccountWebviewProvider.viewType, webviewProvider)
    );

    // 监听 Webview 数据变更（如账号切换）
    webviewProvider.onDidChangeAccountData(async () => {
        updateStatusBar();
        authProvider.notifySessionChange();
    });

    // 处理切换账号命令（深度切换）
    context.subscriptions.push(vscode.commands.registerCommand('antigravity.switchAccount', async (accountId: string) => {
        if (!accountId) return;

        // 1. 在 DataManager 中设为激活
        await dataManager.setCurrentAccount(accountId);

        // 2. 刷新界面
        await webviewProvider.refresh();
        await updateStatusBar();
        authProvider.notifySessionChange();

        // 3. 注入并重载
        const acc = await dataManager.loadAccount(accountId);
        if (acc) {
            const ans = await vscode.window.showInformationMessage(
                `即将切换到 ${acc.email}。编辑器将会重载以应用更改。`,
                "确认切换", "取消"
            );
            if (ans === "确认切换") {
                try {
                    try {
                        // 计算过期时间戳 (使用 expiry_timestamp 或基于 expires_in 计算)
                        let expiry = acc.token.expiry_timestamp;
                        if (!expiry && acc.token.expires_in) {
                            expiry = Math.floor(Date.now() / 1000) + acc.token.expires_in;
                        }
                        if (!expiry) expiry = Math.floor(Date.now() / 1000) + 3600; // 默认回退

                        await stateInjector.injectTokenAndReload({
                            ...acc.token,
                            expires_in: expiry
                        });

                        // 注入后：提示完全重启
                        const restartAns = await vscode.window.showWarningMessage(
                            `账号已切换！为了让编辑器(Cursor/VSCode)底层生效，您必须**完全退出并重启**软件。仅刷新窗口无效。`,
                            "立即退出", "稍后重启"
                        );

                        if (restartAns === "立即退出") {
                            vscode.commands.executeCommand('workbench.action.quit');
                        }

                    } catch (e) {
                        vscode.window.showErrorMessage(`切换失败: ${e}`);
                    }
                } catch (e) {
                    // ignore
                }
            }
        }
    }));


    // 状态栏
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'antigravity.toggleWebview';
    context.subscriptions.push(statusBar);

    const updateStatusBar = async () => {
        const index = await dataManager.loadAccountIndex();
        if (index.current_account_id) {
            const acc = await dataManager.loadAccount(index.current_account_id);
            if (acc) {
                const models = acc.quota?.models || {};
                const getMin = (keyword: string) => {
                    let min: number | null = null;
                    for (const k in models) {
                        if (k.toLowerCase().includes(keyword)) {
                            const p = models[k].percentage;
                            if (min === null || p < min) min = p;
                        }
                    }
                    return min;
                };

                const claude = getMin('claude');
                const pro = getMin('pro'); // Covers gemini pro
                const flash = getMin('flash'); // Covers gemini flash

                const parts: string[] = [];
                const getIcon = (p: number) => p >= 50 ? '🟢' : (p >= 30 ? '🟡' : '🔴');

                if (claude !== null) parts.push(`${getIcon(claude)} Claude: ${claude}%`);
                if (pro !== null) parts.push(`${getIcon(pro)} G Pro: ${pro}%`);
                if (flash !== null) parts.push(`${getIcon(flash)} G Flash: ${flash}%`);

                if (parts.length > 0) {
                    statusBar.text = parts.join('   ');
                } else {
                    statusBar.text = `$(rocket) ${acc.email} (${acc.quota?.remaining_quota ?? '?'}%)`;
                }

                statusBar.show();
                return;
            }
        }
        statusBar.text = `$(rocket) Antigravity`;
        statusBar.show();
    };

    // 命令注册
    context.subscriptions.push(vscode.commands.registerCommand('antigravity.refresh', async () => {
        await webviewProvider.refreshAllQuotas(); // 触发 Webview 内部更新
        await updateStatusBar();
    }));

    // 聚焦视图命令
    context.subscriptions.push(vscode.commands.registerCommand('antigravity.toggleWebview', async () => {
        await vscode.commands.executeCommand('antigravity-accounts-webview.focus');
    }));

    context.subscriptions.push(vscode.commands.registerCommand('antigravity.addAccount', async () => {
        vscode.window.showInformationMessage("正在打开浏览器登录 Google...");
        const newAccount = await authService.startLoginFlow();
        if (newAccount) {
            vscode.window.showInformationMessage(`添加成功: ${newAccount.email}`);
            await webviewProvider.refreshAllQuotas();
            await updateStatusBar();
        }
    }));

    // 初始化加载
    await updateStatusBar();

    // 自动刷新循环
    const config = vscode.workspace.getConfiguration('antigravity');
    const refreshInterval = config.get<number>('refreshInterval', 3); // Default 3 minutes

    if (refreshInterval > 0) {

        const intervalMs = refreshInterval * 60 * 1000;
        const intervalId = setInterval(async () => {

            await webviewProvider.refreshAllQuotas();
            await updateStatusBar();
        }, intervalMs);
        context.subscriptions.push({ dispose: () => clearInterval(intervalId) });
    }
}

export function deactivate() { }
