import * as vscode from 'vscode';
import { DataManager, Account } from './services/DataManager';
import { GeminiClient } from './services/GeminiClient';
import { AuthService } from './services/AuthService';
import { AccountWebviewProvider } from './AccountWebviewProvider';
import { AntigravityAuthenticationProvider } from './AuthenticationProvider';
import { StateInjector } from './services/StateInjector';
import { StatusBarController } from './controller/status_bar_controller';
import { DashboardController } from './controller/DashboardController';
import { TriggerService } from './services/TriggerService';
import { SchedulerService } from './services/SchedulerService';

export async function activate(context: vscode.ExtensionContext) {


    const dataManager = new DataManager();
    const geminiClient = new GeminiClient();
    const authService = new AuthService(dataManager);
    const triggerService = new TriggerService(dataManager, geminiClient);
    const schedulerService = new SchedulerService();

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

    // 注册 Webview 提供者 (Sidebar)
    const webviewProvider = new AccountWebviewProvider(
        context.extensionUri,
        dataManager,
        geminiClient,
        triggerService,
        schedulerService
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(AccountWebviewProvider.viewType, webviewProvider)
    );

    // 注册 Dashboard 控制器 (Full Panel) - Removing per user request
    // const dashboardController = new DashboardController(context, dataManager, triggerService, schedulerService);
    // context.subscriptions.push(vscode.commands.registerCommand('antigravity.openDashboard', () => {
    //    dashboardController.openDashboard();
    // }));

    // 监听 Webview 数据变更（如账号切换）
    webviewProvider.onDidChangeAccountData(async () => {
        updateStatusBar();
        authProvider.notifySessionChange();
        // 如果 Dashboard 打开，通知它更新
        // dashboardController.broadcastRefresh(); // Method is private in current impl, maybe make public or trigger via event
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


    // 状态栏控制器
    const statusBarController = new StatusBarController(context);

    const updateStatusBar = async () => {
        const index = await dataManager.loadAccountIndex();
        if (index.current_account_id) {
            const acc = await dataManager.loadAccount(index.current_account_id);
            if (acc) {
                // 适配数据结构
                const models = acc.quota?.models;
                statusBarController.update(models as any, acc.email);
                return;
            }
        }
        // No account or load failed
        statusBarController.update(undefined);
    };

    // 监听配置变化，实时更新状态栏
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravity.statusBarFormat') ||
            e.affectsConfiguration('antigravity.warningThreshold') ||
            e.affectsConfiguration('antigravity.criticalThreshold')) {
            updateStatusBar();
        }
    }));

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
