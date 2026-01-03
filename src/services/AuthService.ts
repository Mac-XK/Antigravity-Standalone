import * as http from 'http';
import * as vscode from 'vscode';
import axios from 'axios';
import { Account, TokenData, DataManager } from './DataManager';

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

export class AuthService {

    constructor(private dataManager: DataManager) { }

    public async startLoginFlow(): Promise<Account | null> {
        // 1. 启动本地服务器监听回调
        const server = http.createServer();

        return new Promise<Account | null>((resolve, reject) => {
            let listening = false;

            server.on('request', async (req, res) => {
                if (!req.url) return;
                const url = new URL(req.url, `http://127.0.0.1:${(server.address() as any).port}`);

                if (url.pathname === '/oauth-callback') {
                    const code = url.searchParams.get('code');
                    const error = url.searchParams.get('error');

                    if (code) {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(`<html><body style='font-family: sans-serif; text-align: center; padding: 50px;'><h1 style='color: green;'>✅ 授权成功!</h1><p>您可以关闭此窗口返回 VS Code。</p><script>setTimeout(function() { window.close(); }, 2000);</script></body></html>`);

                        try {
                            try {
                                // 2. 换取 Token
                                const redirectUri = `http://127.0.0.1:${(server.address() as any).port}/oauth-callback`;
                                const tokenResponse = await this.exchangeCode(code, redirectUri);

                                // 3. 获取用户信息
                                const userInfo = await this.getUserInfo(tokenResponse.access_token);

                                // 4. 创建账号对象
                                const account: Account = {
                                    id: userInfo.id, // 使用 Google ID 作为账号 ID
                                    email: userInfo.email,
                                    name: userInfo.name,
                                    picture: userInfo.picture,
                                    token: {
                                        access_token: tokenResponse.access_token,
                                        refresh_token: tokenResponse.refresh_token,
                                        expires_in: tokenResponse.expires_in,
                                        email: userInfo.email,
                                        expiry_timestamp: Math.floor(Date.now() / 1000) + tokenResponse.expires_in
                                    },
                                    created_at: Math.floor(Date.now() / 1000),
                                    last_used: Math.floor(Date.now() / 1000)
                                };

                                // 5. 保存账号
                                await this.dataManager.saveAccount(account);

                                // 保存到索引
                                await this.dataManager.addToIndex(account);

                                // 若无当前账号，自动设为激活
                                const index = await this.dataManager.loadAccountIndex();
                                if (!index.current_account_id) {
                                    await this.dataManager.setCurrentAccount(account.id);
                                }

                                resolve(account);
                            } catch (e) {
                                vscode.window.showErrorMessage(`Login Failed: ${e}`);
                                resolve(null);
                            } finally {
                                server.close();
                            }
                        } catch (e) {
                            // ignore
                        }
                    } else {
                        res.writeHead(400);
                        res.end('Authorization failed.');
                        resolve(null);
                        server.close();
                    }
                }
            });

            server.listen(0, '127.0.0.1', async () => {
                listening = true;
                const port = (server.address() as any).port;
                const redirectUri = `http://127.0.0.1:${port}/oauth-callback`;

                const scopes = [
                    "https://www.googleapis.com/auth/cloud-platform",
                    "https://www.googleapis.com/auth/userinfo.email",
                    "https://www.googleapis.com/auth/userinfo.profile",
                    "https://www.googleapis.com/auth/cclog",
                    "https://www.googleapis.com/auth/experimentsandconfigs"
                ].join(" ");

                const params = new URLSearchParams({
                    client_id: CLIENT_ID,
                    redirect_uri: redirectUri,
                    response_type: "code",
                    scope: scopes,
                    access_type: "offline",
                    prompt: "consent",
                    include_granted_scopes: "true"
                });

                const authUrl = `${AUTH_URL}?${params.toString()}`;



                // 打开浏览器
                await vscode.env.openExternal(vscode.Uri.parse(authUrl));
            });

            // 超时保护 (5分钟)
            setTimeout(() => {
                if (listening) {
                    server.close();
                    resolve(null); // Timeout
                }
            }, 60000 * 5);
        });
    }

    private async exchangeCode(code: string, redirectUri: string): Promise<any> {
        const res = await axios.post(TOKEN_URL, {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            redirect_uri: redirectUri,
            grant_type: "authorization_code"
        });
        return res.data;
    }

    private async getUserInfo(accessToken: string): Promise<any> {
        const res = await axios.get(USERINFO_URL, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        return res.data;
    }
}
