import axios from 'axios';
import { Account, TokenData, QuotaData } from './DataManager';

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const QUOTA_API_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

export class GeminiClient {

    async refreshToken(account: Account): Promise<string | null> {

        try {
            const response = await axios.post(TOKEN_URL, null, {
                params: {
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    refresh_token: account.token.refresh_token,
                    grant_type: 'refresh_token'
                }
            });

            if (response.data && response.data.access_token) {
                const newAccessToken = response.data.access_token;
                const expiresIn = response.data.expires_in;

                // Update account token in memory (caller should save)
                account.token.access_token = newAccessToken;
                account.token.expires_in = expiresIn;
                account.token.expiry_timestamp = Math.floor(Date.now() / 1000) + expiresIn;

                return newAccessToken;
            }
        } catch (error) {

        }
        return null;
    }

    async ensureValidToken(account: Account): Promise<string | null> {
        const now = Math.floor(Date.now() / 1000);
        // Buffer of 5 minutes
        if (account.token.expiry_timestamp && account.token.expiry_timestamp > now + 300) {
            return account.token.access_token;
        }
        return await this.refreshToken(account);
    }

    async getProjectID(accessToken: string): Promise<string | null> {
        try {
            const res = await axios.post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
                { metadata: { ideType: "ANTIGRAVITY" } },
                {
                    headers: {
                        "Authorization": `Bearer ${accessToken}`,
                        "Content-Type": "application/json",
                        "User-Agent": "antigravity/vscode-standalone"
                    }
                });
            return res.data?.cloudaicompanionProject || null;
        } catch (e) {

            return null;
        }
    }

    async fetchQuota(account: Account): Promise<QuotaData | null> {
        const token = await this.ensureValidToken(account);
        if (!token) return null;

        // Ensure we have a project ID
        let projectId = account.token.project_id;
        if (!projectId) {
            projectId = await this.getProjectID(token) || "bamboo-precept-lgxtn";
            account.token.project_id = projectId; // Should trigger save in DataManager
        }

        try {
            const res = await axios.post(QUOTA_API_URL,
                { project: projectId },
                {
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "User-Agent": "antigravity/vscode-standalone"
                    }
                }
            );

            // Parse response
            const models = res.data.models;
            let remaining = 0;
            let total = 100;
            const modelData: any = {};

            // Heuristic: Find gemini models and take detailed info
            for (const [key, val] of Object.entries(models || {})) {
                const v = val as any;
                if (key.includes('gemini') || key.includes('claude')) {
                    if (v.quotaInfo) {
                        const frac = v.quotaInfo.remainingFraction ?? 0;
                        const reset = v.quotaInfo.resetTime;
                        modelData[key] = {
                            percentage: Math.round(frac * 100),
                            reset_time: reset
                        };
                    }
                }
            }

            // Conservative Logic:
            // Take the MINIMUM remaining quota of all identified models.
            // This avoids showing 100% just because a free/flash model is full.

            let minQuota = 100;
            let found = false;

            for (const k in modelData) {
                const p = modelData[k].percentage;
                if (p < minQuota) minQuota = p;
                found = true;
            }

            if (found) remaining = minQuota;

            return {
                total_quota: total,
                used_quota: total - remaining, // Fake used
                remaining_quota: remaining,
                models: modelData
            };

        } catch (error: any) {

            if (error?.response?.status === 403) {
                return { total_quota: 0, used_quota: 0, remaining_quota: 0, is_forbidden: true };
            }
            return null;
        }
    }
}
