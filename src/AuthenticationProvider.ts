import * as vscode from 'vscode';
import { DataManager, Account } from './services/DataManager';

export class AntigravityAuthenticationProvider implements vscode.AuthenticationProvider {
    private _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
    get onDidChangeSessions() { return this._onDidChangeSessions.event; }

    constructor(private readonly context: vscode.ExtensionContext, private dataManager: DataManager) {
    }

    async getSessions(scopes?: string[]): Promise<vscode.AuthenticationSession[]> {
        const index = await this.dataManager.loadAccountIndex();
        if (!index.current_account_id) {
            return [];
        }

        const account = await this.dataManager.loadAccount(index.current_account_id);
        if (!account) {
            return [];
        }

        return [this.convertToSession(account)];
    }

    async createSession(scopes: string[]): Promise<vscode.AuthenticationSession> {
        // This is called when another extension asks for a session, or user clicks "Sign In" in the Accounts menu
        // We trigger our existing UI flow or just wait?
        // Since our UI is Webview based, we can trigger the addAccount command.
        // But createSession expects a returned session. 
        // We might not be able to fulfill this easily without blocking.
        // For now, let's just return the current one if exists, or throw.
        // Or better, let's trigger the login flow!

        vscode.commands.executeCommand('antigravity.addAccount');

        // We can't easily wait for the user to finish the browser flow here since it's decoupled.
        // So we throw an error saying "Please use Antigravity view to sign in".
        throw new Error('Please use the Antigravity Sidebar to add a new account.');
    }

    async removeSession(sessionId: string): Promise<void> {
        // Called when user clicks "Sign Out"
        // We probably shouldn't delete the account data, just unset it as active?
        // Or actually remove it? "Sign Out" usually means remove session.
        // Let's just unset current account for now to be safe, or do nothing.
        // User asked to "switch", not delete.
        // If we return empty list, it's effectively signed out.
        await this.dataManager.setCurrentAccount(undefined);
        this.notifySessionChange();
    }

    public notifySessionChange() {
        this._onDidChangeSessions.fire({ added: [], removed: [], changed: [] }); // VS Code will call getSessions()
    }

    private convertToSession(account: Account): vscode.AuthenticationSession {
        return {
            id: account.id,
            accessToken: account.token.access_token, // This is the Gemini token
            account: {
                label: account.email || 'Antigravity User',
                id: account.id
            },
            scopes: ['email', 'profile', 'openid'] // Standard scopes
        };
    }
}
