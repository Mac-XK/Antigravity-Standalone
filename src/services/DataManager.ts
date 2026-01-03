import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

export interface TokenData {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    email: string;
    project_id?: string;
    expiry_timestamp?: number;
}

export interface QuotaData {
    total_quota: number;
    used_quota: number;
    remaining_quota: number;
    models?: Record<string, { percentage: number, reset_time: string }>;
    is_forbidden?: boolean;
}

export interface Account {
    id: string;
    email: string;
    name?: string;
    picture?: string;
    token: TokenData;
    quota?: QuotaData;
    disabled?: boolean;
    created_at: number;
    last_used: number;
}

export interface AccountIndex {
    version: string;
    accounts: {
        id: string;
        email: string;
        name?: string;
        created_at: number;
        last_used: number;
    }[];
    current_account_id?: string;
}

export class DataManager {
    private dataDir: string;
    private accountsDir: string;
    private indexFile: string;

    constructor() {
        this.dataDir = path.join(os.homedir(), '.antigravity_tools');
        this.accountsDir = path.join(this.dataDir, 'accounts');
        this.indexFile = path.join(this.dataDir, 'accounts.json');
    }

    async ensureDirectories() {
        await fs.ensureDir(this.dataDir);
        await fs.ensureDir(this.accountsDir);
    }

    async loadAccountIndex(): Promise<AccountIndex> {
        try {
            await this.ensureDirectories();
            if (!await fs.pathExists(this.indexFile)) {
                return { version: "2.0", accounts: [], current_account_id: undefined };
            }
            return await fs.readJson(this.indexFile);
        } catch (error) {

            return { version: "2.0", accounts: [], current_account_id: undefined };
        }
    }

    async loadAccount(accountId: string): Promise<Account | null> {
        const filePath = path.join(this.accountsDir, `${accountId}.json`);
        try {
            if (!await fs.pathExists(filePath)) return null;
            return await fs.readJson(filePath);
        } catch (error) {

            return null;
        }
    }

    async getAllAccounts(): Promise<Account[]> {
        const index = await this.loadAccountIndex();
        const accounts: Account[] = [];
        for (const summary of index.accounts) {
            const acc = await this.loadAccount(summary.id);
            if (acc) accounts.push(acc);
        }
        return accounts;
    }

    async saveAccount(account: Account): Promise<void> {
        await this.ensureDirectories();
        const filePath = path.join(this.accountsDir, `${account.id}.json`);
        await fs.writeJson(filePath, account, { spaces: 2 });
    }

    async addToIndex(account: Account): Promise<void> {
        const index = await this.loadAccountIndex();
        const existingIdx = index.accounts.findIndex(a => a.id === account.id);

        const summary = {
            id: account.id,
            email: account.email,
            name: account.name,
            created_at: account.created_at,
            last_used: account.last_used
        };

        if (existingIdx >= 0) {
            index.accounts[existingIdx] = summary;
        } else {
            // 检查重复邮箱
            const emailIdx = index.accounts.findIndex(a => a.email === account.email);
            if (emailIdx >= 0) {
                index.accounts[emailIdx] = summary;
            } else {
                index.accounts.push(summary);
            }
        }

        await this.saveAccountIndex(index);
    }

    async saveAccountIndex(index: AccountIndex): Promise<void> {
        await this.ensureDirectories();
        await fs.writeJson(this.indexFile, index, { spaces: 2 });
    }

    async setCurrentAccount(accountId: string | undefined): Promise<void> {
        const index = await this.loadAccountIndex();
        index.current_account_id = accountId;
        await this.saveAccountIndex(index);
    }
}
