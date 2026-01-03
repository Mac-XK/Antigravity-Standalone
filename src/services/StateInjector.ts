import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import { TokenData } from './DataManager';

const execAsync = promisify(exec);

export class StateInjector {
    private dbPath: string | null = null;

    constructor(private context: vscode.ExtensionContext) {
    }

    private async getDbPath(): Promise<string | null> {
        if (this.dbPath) return this.dbPath;

        // 动态路径解析
        // globalStorageUri 指向插件专属目录 (.../Start/globalStorage/publisher.extension)
        // state.vscdb 位于父级目录 (.../User/globalStorage/state.vscdb)
        const globalStorageDir = path.dirname(this.context.globalStorageUri.fsPath);
        const resolvedPath = path.join(globalStorageDir, 'state.vscdb');



        if (await fs.pathExists(resolvedPath)) {

            this.dbPath = resolvedPath;
            return resolvedPath;
        } else {

        }

        // 若动态解析失败，回退到硬编码搜索 (适用于部分特殊版本或 Portable 模式)
        const home = os.homedir();
        const candidates = [
            path.join(home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb'),
            path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb'),
            path.join(home, 'Library/Application Support/Code/User/globalStorage/state.vscdb'),
            path.join(home, '.config/Antigravity/User/globalStorage/state.vscdb'),
        ];

        for (const p of candidates) {
            if (await fs.pathExists(p)) {

                this.dbPath = p;
                return p;
            }
        }

        return null;
    }

    public async injectTokenAndReload(token: TokenData) {
        const dbPath = await this.getDbPath();
        if (!dbPath) {
            throw new Error('Could not find state.vscdb');
        }

        // 1. 读取当前 Token 值
        const currentB64 = await this.readDbValue(dbPath, 'jetskiStateSync.agentManagerInitState');
        let blob: Buffer;

        if (!currentB64) {
            blob = Buffer.alloc(0);
        } else {
            blob = Buffer.from(currentB64, 'base64');
        }

        // 2. 移除旧的 Field 6
        const cleanData = ProtoUtils.removeField(blob, 6);

        // 3. 创建新的 Field 6
        const newField = ProtoUtils.createOAuthField(
            token.access_token,
            token.refresh_token,
            token.expires_in
        );

        // 4. 合并数据
        const finalData = Buffer.concat([cleanData, newField]);
        const finalB64 = finalData.toString('base64');

        // 5. 写入数据库
        await this.writeDbValue(dbPath, 'jetskiStateSync.agentManagerInitState', finalB64);

        // 6. 写入 onboarding 标志（避免重新登录引导）
        await this.writeDbValue(dbPath, 'antigravityOnboarding', 'true');


    }

    private async readDbValue(dbPath: string, key: string): Promise<string | null> {
        try {
            // Use sqlite3 CLI
            // Command: sqlite3 "path" "SELECT value FROM ItemTable WHERE key='...'"
            const cmd = `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key='${key}' limit 1"`;
            const { stdout } = await execAsync(cmd);
            return stdout.trim() || null;
        } catch (e) {

            return null;
        }
    }

    private async writeDbValue(dbPath: string, key: string, value: string): Promise<void> {
        // Update or Insert
        // Use Transaction? sqlite3 CLI one-liner
        // "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('key', 'value')"
        // But value might be huge, command line args limit?
        // Base64 is text, usually fine unless HUGE.
        // Rust code used UPDATE then INSERT OR REPLACE.

        // Let's try INSERT OR REPLACE directly.
        // Escape single quotes in value
        const escapedValue = value.replace(/'/g, "''");
        const cmd = `sqlite3 "${dbPath}" "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${key}', '${escapedValue}')"`;
        await execAsync(cmd);
    }
}

class ProtoUtils {
    static encodeVarint(value: number): Buffer {
        const bytes: number[] = [];
        let v = BigInt(value);
        while (v >= 128n) {
            bytes.push(Number((v & 127n) | 128n));
            v >>= 7n;
        }
        bytes.push(Number(v));
        return Buffer.from(bytes);
    }

    static readVarint(buffer: Buffer, offset: number): { value: number, newOffset: number } {
        let result = 0n;
        let shift = 0n;
        let pos = offset;

        while (pos < buffer.length) {
            const byte = BigInt(buffer[pos]);
            result |= (byte & 127n) << shift;
            pos++;
            if ((byte & 128n) === 0n) {
                break;
            }
            shift += 7n;
        }
        // Return number if safe, else we might lose precision but for field tags it's fine
        return { value: Number(result), newOffset: pos };
    }

    static skipField(buffer: Buffer, offset: number, wireType: number): number {
        switch (wireType) {
            case 0: // Varint
                const res = this.readVarint(buffer, offset);
                return res.newOffset;
            case 1: // 64-bit
                return offset + 8;
            case 2: // Length-delimited
                const { value: length, newOffset } = this.readVarint(buffer, offset);
                return newOffset + length;
            case 5: // 32-bit
                return offset + 4;
            default:
                throw new Error(`Unknown wireType: ${wireType}`);
        }
    }

    static removeField(buffer: Buffer, fieldNumToRemove: number): Buffer {
        let offset = 0;
        const chunks: Buffer[] = [];

        while (offset < buffer.length) {
            const startOffset = offset;
            const { value: tag, newOffset } = this.readVarint(buffer, offset);
            const wireType = tag & 7;
            const fieldNum = tag >> 3;

            if (fieldNum === fieldNumToRemove) {
                // Skip
                offset = this.skipField(buffer, newOffset, wireType);
            } else {
                // Keep
                const nextOffset = this.skipField(buffer, newOffset, wireType);
                chunks.push(buffer.subarray(startOffset, nextOffset));
                offset = nextOffset;
            }
        }

        return Buffer.concat(chunks);
    }

    static createOAuthField(accessToken: string | undefined, refreshToken: string, expiry: number): Buffer {
        const parts: Buffer[] = [];

        // Field 1: access_token (string, wireType=2)
        if (accessToken) {
            parts.push(this.encodeTag(1, 2));
            const buf = Buffer.from(accessToken, 'utf8');
            parts.push(this.encodeVarint(buf.length));
            parts.push(buf);
        }

        // Field 2: token_type ("Bearer", wireType=2)
        {
            parts.push(this.encodeTag(2, 2));
            const buf = Buffer.from("Bearer", 'utf8');
            parts.push(this.encodeVarint(buf.length));
            parts.push(buf);
        }

        // Field 3: refresh_token (string, wireType=2)
        if (refreshToken) {
            parts.push(this.encodeTag(3, 2));
            const buf = Buffer.from(refreshToken, 'utf8');
            parts.push(this.encodeVarint(buf.length));
            parts.push(buf);
        }

        // Field 4: expiry (Timestamp, wireType=2)
        {
            // Inner message
            const innerParts: Buffer[] = [];
            innerParts.push(this.encodeTag(1, 0));
            // expiry 应该是绝对时间戳 (秒)
            innerParts.push(this.encodeVarint(expiry));
            const innerBuf = Buffer.concat(innerParts);

            parts.push(this.encodeTag(4, 2));
            parts.push(this.encodeVarint(innerBuf.length));
            parts.push(innerBuf);
        }

        const oauthInfo = Buffer.concat(parts);

        // Wrap in Field 6
        const wrapper: Buffer[] = [];
        wrapper.push(this.encodeTag(6, 2));
        wrapper.push(this.encodeVarint(oauthInfo.length));
        wrapper.push(oauthInfo);

        return Buffer.concat(wrapper);
    }

    static encodeTag(fieldNum: number, wireType: number): Buffer {
        return this.encodeVarint((fieldNum << 3) | wireType);
    }
}
