
import { parseExpression } from 'cron-parser';
import { logger, t } from '../utils';

export interface ScheduleConfig {
    enabled: boolean;
    repeatMode: 'daily' | 'weekly' | 'interval';
    dailyTimes?: string[];
    weeklyDays?: number[];
    weeklyTimes?: string[];
    intervalHours?: number;
    intervalStartTime?: string;
    intervalEndTime?: string;
    crontab?: string;
    selectedModels?: string[];
}

export interface CrontabParseResult {
    valid: boolean;
    description?: string;
    nextRuns?: Date[];
    error?: string;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

class CronParser {
    static configToCrontab(config: ScheduleConfig): string {
        switch (config.repeatMode) {
            case 'daily':
                return this.dailyToCrontab(config.dailyTimes || []);
            case 'weekly':
                return this.weeklyToCrontab(config.weeklyDays || [], config.weeklyTimes || []);
            case 'interval':
                return this.intervalToCrontab(
                    config.intervalHours || 4,
                    config.intervalStartTime || '00:00',
                    config.intervalEndTime
                );
            default:
                return '0 8 * * *';
        }
    }

    private static dailyToCrontab(times: string[]): string {
        if (times.length === 0) return '0 8 * * *';
        const minuteGroups = new Map<number, number[]>();
        for (const time of times) {
            const [h, m] = time.split(':').map(Number);
            if (!minuteGroups.has(m)) minuteGroups.set(m, []);
            minuteGroups.get(m)!.push(h);
        }
        const expressions: string[] = [];
        for (const [minute, hours] of minuteGroups) {
            const hourList = hours.sort((a, b) => a - b).join(',');
            expressions.push(`${minute} ${hourList} * * *`);
        }
        return expressions.join(';');
    }

    private static weeklyToCrontab(days: number[], times: string[]): string {
        if (days.length === 0 || times.length === 0) return '0 8 * * 1-5';
        const sortedDays = [...days].sort((a, b) => a - b);
        let dayExpr = this.isConsecutive(sortedDays)
            ? `${sortedDays[0]}-${sortedDays[sortedDays.length - 1]}`
            : sortedDays.join(',');

        const minuteGroups = new Map<number, number[]>();
        for (const time of times) {
            const [h, m] = time.split(':').map(Number);
            if (!minuteGroups.has(m)) minuteGroups.set(m, []);
            minuteGroups.get(m)!.push(h);
        }
        const expressions: string[] = [];
        for (const [minute, hours] of minuteGroups) {
            const hourList = hours.sort((a, b) => a - b).join(',');
            expressions.push(`${minute} ${hourList} * * ${dayExpr}`);
        }
        return expressions.join(';');
    }

    private static intervalToCrontab(intervalHours: number, startTime: string, endTime?: string): string {
        const [startH, startM] = startTime.split(':').map(Number);
        const endH = endTime ? parseInt(endTime.split(':')[0], 10) : 23;
        const hours: number[] = [];
        for (let h = startH; h <= endH; h += intervalHours) hours.push(h);
        if (hours.length === 0) hours.push(startH);
        return `${startM} ${hours.join(',')} * * *`;
    }

    private static isConsecutive(arr: number[]): boolean {
        if (arr.length <= 1) return true;
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] !== arr[i - 1] + 1) return false;
        }
        return true;
    }

    static parse(crontab: string): CrontabParseResult {
        try {
            const expressions = crontab.split(';').filter(e => e.trim());
            if (expressions.length === 0) return { valid: false, error: 'Invalid crontab format' };

            const allDescriptions: string[] = [];
            for (const expr of expressions) {
                const parts = expr.trim().split(/\s+/);
                if (parts.length !== 5) return { valid: false, error: 'Invalid format (needs 5 fields)' };
                // Simplified description logic
                allDescriptions.push(expr);
            }
            const nextRuns = this.getNextRuns(crontab, 5);
            return { valid: true, description: allDescriptions.join('; '), nextRuns };
        } catch (error) {
            return { valid: false, error: String(error) };
        }
    }

    static getNextRuns(crontab: string, count: number): Date[] {
        try {
            const expressions = crontab.split(';').filter(e => e.trim());
            const allDates: Date[] = [];
            for (const expr of expressions) {
                const interval = parseExpression(expr.trim(), {
                    currentDate: new Date(),
                    tz: LOCAL_TIMEZONE,
                });
                for (let i = 0; i < count; i++) allDates.push(interval.next().toDate());
            }
            const uniqueDates = Array.from(new Map(allDates.map(d => [d.getTime(), d])).values());
            uniqueDates.sort((a, b) => a.getTime() - b.getTime());
            return uniqueDates.slice(0, count);
        } catch {
            return [];
        }
    }
}

export class SchedulerService {
    private timer?: ReturnType<typeof setTimeout>;
    private schedule?: ScheduleConfig;
    private onTrigger?: () => Promise<void>;

    setSchedule(config: ScheduleConfig, onTrigger: () => Promise<void>): void {
        this.schedule = config;
        this.onTrigger = onTrigger;
        if (config.enabled) this.start();
        else this.stop();
    }

    getSchedule(): ScheduleConfig | undefined {
        return this.schedule;
    }

    start(): void {
        if (!this.schedule || !this.onTrigger) return;
        if (this.timer) this.stop();
        this.scheduleNextRun();
        logger.info('[SchedulerService] Started');
    }

    stop(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        logger.info('[SchedulerService] Stopped');
    }

    getNextRunTime(): Date | null {
        if (!this.schedule || !this.schedule.enabled) return null;
        const crontab = this.schedule.crontab || CronParser.configToCrontab(this.schedule);
        const nextRuns = CronParser.getNextRuns(crontab, 1);
        return nextRuns.length > 0 ? nextRuns[0] : null;
    }

    configToCrontab(config: ScheduleConfig): string {
        return CronParser.configToCrontab(config);
    }

    validateCrontab(crontab: string): CrontabParseResult {
        return CronParser.parse(crontab);
    }

    private scheduleNextRun(): void {
        if (!this.schedule || !this.onTrigger) return;
        const nextRun = this.getNextRunTime();
        if (!nextRun) return;

        const delay = nextRun.getTime() - Date.now();
        if (delay < 0) {
            this.timer = setTimeout(() => this.scheduleNextRun(), 60000);
            return;
        }

        if (delay > MAX_TIMER_DELAY_MS) {
            this.timer = setTimeout(() => this.scheduleNextRun(), MAX_TIMER_DELAY_MS);
            return;
        }

        logger.info(`[SchedulerService] Next run: ${nextRun.toLocaleString()}`);
        this.timer = setTimeout(async () => {
            try {
                await this.onTrigger!();
            } catch (err: any) {
                logger.error(`[SchedulerService] Trigger failed: ${err.message}`);
            }
            if (this.schedule && this.schedule.enabled) this.scheduleNextRun();
        }, delay);
    }
}
