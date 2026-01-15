
import * as vscode from 'vscode';

export const logger = {
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    warn: (msg: string) => console.warn(`[WARN] ${msg}`),
    error: (msg: string, err?: any) => console.error(`[ERROR] ${msg}`, err),
    debug: (msg: string) => console.debug(`[DEBUG] ${msg}`)
};

export const t = (key: string, args?: any) => {
    // Simple stub for i18n
    const map: Record<string, string> = {
        'dashboard.title': 'Antigravity Dashboard',
        'autoTrigger.tabTitle': 'Auto Trigger',
        'quotaSource.title': 'Quota Source',
        'quotaSource.local': 'Local',
        'quotaSource.authorized': 'Authorized',
        'common.weekday.sun': 'Sunday',
        'common.weekday.mon': 'Monday',
        'common.weekday.tue': 'Tuesday',
        'common.weekday.wed': 'Wednesday',
        'common.weekday.thu': 'Thursday',
        'common.weekday.fri': 'Friday',
        'common.weekday.sat': 'Saturday',
        'autoTrigger.desc.workday': 'Workdays (Mon-Fri)',
        'autoTrigger.desc.weekend': 'Weekends',
        'autoTrigger.desc.dailyAt': 'Daily at {times}',
        'autoTrigger.desc.custom': 'Custom Schedule',
        'autoTrigger.desc.hourly': 'Hourly'
    };
    let val = map[key] || key;
    if (args) {
        Object.keys(args).forEach(k => {
            val = val.replace(`{${k}}`, args[k]);
        });
    }
    return val;
};

export const i18n = {
    getLocale: () => vscode.env.language,
    getAllTranslations: () => ({})
};
