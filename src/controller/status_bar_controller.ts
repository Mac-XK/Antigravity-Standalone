
import * as vscode from 'vscode';

// 定义需要的接口，适配 AccountWebviewProvider 中的数据结构
export interface ModelQuotaData {
    percentage: number;
    reset_time: string;
}

export interface QuotaModels {
    [key: string]: ModelQuotaData;
}

export interface StatusBarConfig {
    format: string;
    warningThreshold: number;
    criticalThreshold: number;
}

// 状态栏格式枚举
export enum StatusBarFormat {
    ICON = 'icon',
    DOT = 'dot',
    PERCENT = 'percent',
    COMPACT = 'compact',
    NAME_PERCENT = 'namePercent',
    STANDARD = 'standard'
}

export class StatusBarController {
    private statusBarItem: vscode.StatusBarItem;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        // 优先级设为 100，确保靠前显示
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100,
        );
        this.statusBarItem.command = 'antigravity-accounts-webview.focus'; // 点击打开侧边栏
        this.statusBarItem.text = `$(rocket) Antigravity`;
        this.statusBarItem.tooltip = 'Antigravity Quota Monitor';
        this.statusBarItem.show();

        context.subscriptions.push(this.statusBarItem);
    }

    /**
     * 更新状态栏
     * @param models 模型配额数据
     * @param accountEmail 当前账号邮箱（用于显示 tooltip 标题）
     */
    public update(models: QuotaModels | undefined, accountEmail?: string): void {
        const config = this.getConfig();

        if (!models) {
            this.setLoading();
            return;
        }

        // 仅图标模式
        if (config.format === StatusBarFormat.ICON) {
            this.statusBarItem.text = '🚀';
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = this.generateQuotaTooltip(models, accountEmail, config);
            return;
        }

        const statusTextParts: string[] = [];

        // Helper to find specific models - returns the one with LOWEST percentage among matches
        const findModel = (keywords: string[], excludeKeywords: string[] = []) => {
            const matches = Object.entries(models).filter(([originalKey, data]) => {
                const lower = originalKey.toLowerCase();
                // Exclude 2.5 models as requested previously
                if (lower.includes('2.5')) return false;
                // Exclude any specified keywords
                if (excludeKeywords.some(k => lower.includes(k))) return false;
                return keywords.some(k => lower.includes(k));
            });
            // Return the match with lowest percentage
            if (matches.length === 0) return undefined;
            return matches.reduce((min, curr) =>
                curr[1].percentage < min[1].percentage ? curr : min
            );
        };

        // 1. Claude
        const claudeEntry = findModel(['claude-3-5-sonnet', 'claude']);
        if (claudeEntry) {
            const pct = claudeEntry[1].percentage;
            const icon = this.getStatusIcon(pct, config);
            statusTextParts.push(`${icon} Claude: ${pct.toFixed(0)}%`);
        }

        // 2. G Pro (exclude image models to show Pro High/Low)
        const proEntry = findModel(['gemini-1.5-pro', 'pro'], ['image']);
        if (proEntry) {
            const pct = proEntry[1].percentage;
            const icon = this.getStatusIcon(pct, config);
            statusTextParts.push(`${icon} G Pro: ${pct.toFixed(0)}%`);
        }

        // 3. G Flash
        const flashEntry = findModel(['gemini-1.5-flash', 'flash']);
        if (flashEntry) {
            const pct = flashEntry[1].percentage;
            const icon = this.getStatusIcon(pct, config);
            statusTextParts.push(`${icon} G Flash: ${pct.toFixed(0)}%`);
        }

        // Fallback if nothing found (e.g. initial load or no matching models)
        if (statusTextParts.length === 0) {
            // Try getting ANY model lowest
            const all = Object.values(models).map(m => m.percentage);
            if (all.length > 0) {
                const min = Math.min(...all);
                statusTextParts.push(`${this.getStatusIcon(min, config)} Quota: ${min.toFixed(0)}%`);
            } else {
                statusTextParts.push(`$(check) Ready`);
            }
        }

        this.statusBarItem.text = statusTextParts.join('  '); // Use double space for separation
        this.statusBarItem.backgroundColor = undefined;
        this.statusBarItem.tooltip = this.generateQuotaTooltip(models, accountEmail, config);
    }

    public setLoading(text?: string): void {
        this.statusBarItem.text = `$(sync~spin) ${text || 'Connecting...'}`;
        this.statusBarItem.backgroundColor = undefined;
    }

    public setError(message: string): void {
        this.statusBarItem.text = `$(error) Error`;
        this.statusBarItem.tooltip = message;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    private getConfig(): StatusBarConfig {
        const config = vscode.workspace.getConfiguration('antigravity');
        return {
            format: config.get<string>('statusBarFormat', 'standard'),
            warningThreshold: config.get<number>('warningThreshold', 50),
            criticalThreshold: config.get<number>('criticalThreshold', 20),
        };
    }

    private formatModelName(key: string): string {
        // Custom mappings for cleaner display
        if (key.includes('claude-3-5-sonnet')) return 'Claude 3.5 Sonnet';
        if (key.includes('claude-3-opus')) return 'Claude 3 Opus';
        if (key.includes('gemini-1.5-pro')) return 'Gemini 1.5 Pro';
        if (key.includes('gemini-1.5-flash')) return 'Gemini 1.5 Flash';
        if (key.includes('gemini-ultra')) return 'Gemini Ultra';

        // Fallback: Capitalize and replace hyphens
        // Fallback: Capitalize and replace hyphens
        // Fix 4-5 or 4_5 -> 4.5
        const cleanKey = key.replace(/(\d+)[-_](\d+)/g, '$1.$2');
        let formatted = cleanKey.replace(/-/g, ' ').replace(/_/g, ' ');
        // Capitalize
        formatted = formatted.replace(/\b\w/g, c => c.toUpperCase());
        // Remove prefixes and fix any remaining space-separated numbers
        return formatted.replace('Gemini ', '').replace('Claude ', '')
            .replace(/(\d+)\s+(\d+)/g, '$1.$2');
    }

    private getStatusIcon(percentage: number, config: StatusBarConfig): string {
        if (percentage < config.criticalThreshold) { return '🔴'; }
        if (percentage <= config.warningThreshold) { return '🟡'; }
        return '🟢';
    }

    private formatStatusBarText(id: string, percentage: number, format: string, config: StatusBarConfig): string {
        const label = this.formatModelName(id);
        const dot = this.getStatusIcon(percentage, config);
        const pct = `${percentage.toFixed(0)}%`;

        switch (format) {
            case StatusBarFormat.ICON:
                return '';
            case StatusBarFormat.DOT:
                return dot;
            case StatusBarFormat.PERCENT:
                return pct;
            case StatusBarFormat.COMPACT:
                return `${dot} ${pct}`;
            case StatusBarFormat.NAME_PERCENT:
                return `${label}: ${pct}`;
            case StatusBarFormat.STANDARD:
            default:
                return `${dot} ${label}: ${pct}`;
        }
    }

    private generateCompactProgressBar(percentage: number): string {
        const total = 8;
        const filled = Math.round((percentage / 100) * total);
        const empty = total - filled;
        return '■'.repeat(filled) + '□'.repeat(empty);
    }

    private generateQuotaTooltip(models: QuotaModels, accountEmail: string | undefined, config: StatusBarConfig): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        const title = accountEmail ? `Antigravity: ${accountEmail}` : 'Antigravity Quota Monitor';
        md.appendMarkdown(`**${title}**\n\n`); // Removed rocket icon

        md.appendMarkdown('| | | | |\n');
        md.appendMarkdown('| :--- | :--- | :--- | :--- |\n');

        // Filter: Hide 2.5 models
        // Sort: Pro Image at bottom
        const modelList = Object.entries(models)
            .filter(([key]) => !key.includes('2.5'))
            .map(([key, data]) => ({
                id: key,
                label: this.formatModelName(key),
                percentage: data.percentage,
                resetTime: data.reset_time
            }))
            .sort((a, b) => {
                const isImageA = a.id.toLowerCase().includes('image');
                const isImageB = b.id.toLowerCase().includes('image');
                if (isImageA && !isImageB) return 1;
                if (!isImageA && isImageB) return -1;
                return a.label.localeCompare(b.label);
            });

        for (const model of modelList) {
            const pct = model.percentage;
            const icon = this.getStatusIcon(pct, config);
            const bar = this.generateCompactProgressBar(pct);

            let resetDisplay = '-';
            if (model.resetTime) {
                try {
                    const now = new Date();
                    const reset = new Date(model.resetTime);
                    const diffMs = reset.getTime() - now.getTime();
                    if (diffMs > 0) {
                        const h = Math.floor(diffMs / (1000 * 60 * 60));
                        const m = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                        const timeStr = `${h}h ${m}m`;
                        const localTime = reset.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
                        resetDisplay = `→ ${timeStr} (${localTime})`; // Compact format
                    }
                } catch (e) { }
            }

            const pctDisplay = pct.toFixed(2);
            // Markdown table row
            md.appendMarkdown(`| ${icon} **${model.label}** | \`${bar}\` | **${pctDisplay}%** | ${resetDisplay} |\n`);
        }

        md.appendMarkdown(`\n---\n*点击打开配额监控面板*`); // Localized
        return md;
    }
}
