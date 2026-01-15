
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import { DataManager } from './DataManager';
import { GeminiClient } from './GeminiClient';
import { logger } from '../utils';

export interface TriggerRecord {
    timestamp: string;
    success: boolean;
    prompt: string;
    message: string;
    duration: number;
    triggerType: 'manual' | 'auto';
    accountEmail?: string;
}

const TRIGGER_HISTORY_FILE = 'trigger_history.json';
const MAX_HISTORY_ITEMS = 50;

export class TriggerService {
    private dataManager: DataManager;
    private geminiClient: GeminiClient;
    private history: TriggerRecord[] = [];

    constructor(dataManager: DataManager, geminiClient: GeminiClient) {
        this.dataManager = dataManager;
        this.geminiClient = geminiClient;
        this.loadHistory();
    }

    private getHistoryFile(): string {
        return path.join(this.dataManager.getDataDir(), TRIGGER_HISTORY_FILE);
    }

    private async loadHistory() {
        try {
            const file = this.getHistoryFile();
            if (await fs.pathExists(file)) {
                this.history = await fs.readJson(file);
            }
        } catch (e) {
            logger.error('Failed to load trigger history', e);
        }
    }

    private async saveHistory() {
        try {
            await fs.writeJson(this.getHistoryFile(), this.history, { spaces: 2 });
        } catch (e) {
            logger.error('Failed to save trigger history', e);
        }
    }

    public getHistory(): TriggerRecord[] {
        return this.history;
    }

    public async clearHistory() {
        this.history = [];
        await this.saveHistory();
    }

    public async trigger(accountEmail?: string, type: 'manual' | 'auto' = 'manual'): Promise<TriggerRecord> {
        const start = Date.now();
        let targetAccount = null;

        try {
            const accounts = await this.dataManager.getAllAccounts();
            if (accounts.length === 0) throw new Error('No accounts found');

            if (accountEmail) {
                targetAccount = accounts.find(a => a.email === accountEmail);
            } else {
                // Default to current or first
                const idx = await this.dataManager.loadAccountIndex();
                if (idx.current_account_id) {
                    targetAccount = await this.dataManager.loadAccount(idx.current_account_id);
                }
                if (!targetAccount) targetAccount = accounts[0];
            }

            if (!targetAccount) throw new Error('Target account not found');

            const token = await this.geminiClient.ensureValidToken(targetAccount);
            if (!token) throw new Error('Failed to get valid access token');

            // Ensure project ID
            let projectId = targetAccount.token.project_id;
            if (!projectId) {
                projectId = await this.geminiClient.getProjectID(token) || 'bamboo-precept-lgxtn';
                targetAccount.token.project_id = projectId;
                await this.dataManager.saveAccount(targetAccount);
            }

            // Send Keep-Alive Request
            const response = await this.sendKeepAlive(token, projectId);

            const record: TriggerRecord = {
                timestamp: new Date().toISOString(),
                success: true,
                prompt: 'Keep-Alive',
                message: response,
                duration: Date.now() - start,
                triggerType: type,
                accountEmail: targetAccount.email
            };

            this.history.unshift(record);
            if (this.history.length > MAX_HISTORY_ITEMS) this.history.length = MAX_HISTORY_ITEMS;
            await this.saveHistory();

            return record;

        } catch (e: any) {
            const record: TriggerRecord = {
                timestamp: new Date().toISOString(),
                success: false,
                prompt: 'Keep-Alive',
                message: e.message || String(e),
                duration: Date.now() - start,
                triggerType: type,
                accountEmail: targetAccount?.email
            };
            this.history.unshift(record);
            await this.saveHistory();
            throw e;
        }
    }

    private async sendKeepAlive(token: string, projectId: string): Promise<string> {
        const url = `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`;
        const body = {
            project: projectId,
            model: 'gemini-3-flash', // Use a cheap model
            request: {
                contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                generationConfig: { maxOutputTokens: 1, temperature: 0 }
            }
        };

        const res = await axios.post(url, body, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'antigravity/vscode-standalone'
            },
            timeout: 10000
        });

        // Simple parsing check
        if (res.status === 200) return 'OK';
        throw new Error(`API Status: ${res.status}`);
    }
}
