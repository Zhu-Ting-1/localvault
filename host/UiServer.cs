// LocalVault 本地管理后台。
//
// host 进程内嵌一个仅绑定 127.0.0.1 回环的 HTTP 服务：
//   GET  /                → 单文件管理页（内嵌 HTML，无外部依赖）
//   POST /api/<op>        → 与 native messaging 同一套指令（list/get-secret/upsert/delete/…）
//   GET  /api/port        → 查询当前端口（供 vault-ui.cmd 打开正确地址）
//
// 安全边界：
//  - 只绑 loopback，其他机器/局域网访问不到
//  - 随机端口（每次启动不同），不写进任何固定配置
//  - 每次启动生成一次性令牌，/api/* 必须带 X-LV-Token：只有本进程打开的页面知道它，
//    挡掉「扫回环端口 + 一条 curl」这种零成本拖库；令牌文件 ui.token 在数据目录内（同用户可读）
//  - 不加 CORS 头 → 浏览器同源策略阻止任意网页读取响应
//  - DNS rebinding 防护：校验 Host 头必须是 127.0.0.1:<port>
//  - 免密解锁（unlock-resume / unlock-tpm）只留给 native messaging，HTTP 里没有
//  - 写操作要求解锁态；解锁态与扩展共享（同一 vault.db + 文件锁 + 同一 host 实例）
//  - 审计日志：所有敏感操作记录到 audit.log（含操作、条目 id、来源、时间；不含明文密码）
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Globalization;
using System.Text;
using System.Threading;

internal static partial class VaultHost
{
    private static HttpListener _uiListener;
    private static Thread _uiThread;
    private static int _uiPort;

    /// <summary>后台 API 令牌：本进程启动时随机生成，只发给本进程打开的页面。
    /// 页面从地址栏 ?t= 读到后放进 sessionStorage，之后每个请求带 X-LV-Token。</summary>
    private static string _uiToken;

    private static string UiTokenPath
    {
        get { return Path.Combine(_root, "ui.token"); }
    }

    private static string AuditPath
    {
        get { return Path.Combine(_root, "audit.log"); }
    }

    // ---- 空闲自动清零 DEK：让密钥在内存里不常驻 ----
    // 解锁后 10 分钟无任何请求就把 DEK 清掉（会话槽保留，扩展/后台可自动 resume）。
    // 之后哪怕有人拿到内存转储，也拿不到钥匙。需要时重新解密即可。
    private const int DekIdleClearMs = 10 * 60 * 1000;
    private static long _lastActivityTicks = DateTime.UtcNow.Ticks;
    private static System.Threading.Timer _dekIdleTimer;

    /// <summary>每次请求进来就刷新活动时间（两种模式共用）。</summary>
    private static void TouchActivity()
    {
        System.Threading.Interlocked.Exchange(ref _lastActivityTicks, DateTime.UtcNow.Ticks);
    }

    private static void StartDekIdleWatch()
    {
        if (_dekIdleTimer != null) return;
        _dekIdleTimer = new System.Threading.Timer(delegate(object state)
        {
            try
            {
                if (!IsUnlocked()) return;
                long idleMs = (DateTime.UtcNow.Ticks
                    - System.Threading.Interlocked.Read(ref _lastActivityTicks))
                    / TimeSpan.TicksPerMillisecond;
                if (idleMs > DekIdleClearMs)
                {
                    Audit("auto-clear-dek", "idle=" + (idleMs / 1000) + "s");
                    ClearDek();
                }
            }
            catch { /* 定时器异常不致命 */ }
        }, null, 30 * 1000, 30 * 1000);
    }

    // 每个请求线程独立记录来源，避免 HTTP 线程与 native messaging 主线程互相覆盖
    [ThreadStatic]
    private static string _auditSource;

    private static string AuditSourceLabel
    {
        get { return string.IsNullOrEmpty(_auditSource) ? "host" : _auditSource; }
    }

    /// <summary>审计日志：记事件不记密文。密码永不落盘（连哈希都不写）。
    /// 行格式（TAB 分隔，便于表格化/筛选）：UTC 时间 	 来源 	 动作 	 详情。
    /// 来源由 Handle 注入：ext（浏览器扩展）/ ui（本地后台）/ host（内部）。</summary>
    private static void Audit(string action, string detail)
    {
        try
        {
            string ts = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            string clean = (detail ?? "").Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
            string line = ts + "\t" + AuditSourceLabel + "\t" + action + "\t" + clean;

            // 简单轮转：单文件超过 2 MB 归档，保证「详细日志」不会无限膨胀
            try
            {
                FileInfo fi = new FileInfo(AuditPath);
                if (fi.Exists && fi.Length > 2 * 1024 * 1024)
                {
                    string archived = Path.Combine(_root,
                        "audit-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".log");
                    File.Move(AuditPath, archived);
                    // 归档只留最近 10 份，防止 audit-*.log 无限膨胀
                    try
                    {
                        string[] old = Directory.GetFiles(_root, "audit-*.log");
                        Array.Sort(old, StringComparer.Ordinal);
                        for (int i = 0; i < old.Length - 10; i++) File.Delete(old[i]);
                    }
                    catch { }
                }
            }
            catch { }

            File.AppendAllText(AuditPath, line + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { /* 审计失败不阻塞业务 */ }
    }

    private static void Audit(string action)
    {
        Audit(action, "");
    }

    /// <summary>探测 ui.port 里记录的端口是否真有服务在监听（防止陈端口文件）。</summary>
    private static int ReadLiveUiPort()
    {
        Log("probe: enter");
        try
        {
            string f = Path.Combine(_root, "ui.port");
            if (!File.Exists(f)) return 0;
            int port;
            if (!int.TryParse(File.ReadAllText(f).Trim(), out port) || port <= 0) return 0;
            using (System.Net.Sockets.TcpClient c = new System.Net.Sockets.TcpClient())
            {
                Log("probe: tcp connect " + port);
                IAsyncResult ar = c.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(300)) { Log("probe: tcp timeout"); return 0; }
                Log("probe: tcp wait done");
                c.EndConnect(ar);
                Log("probe: tcp ok");
                if (!c.Connected) return 0;
            }
            // 身份校验：端口上有东西在听 ≠ 是我们的服务。
            // GET /api/port 必须能答出本版本号，否则按没服务处理（防陈端口/别的程序占位）。
            try
            {
                HttpWebRequest probe = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/port");
                probe.Timeout = 500;
                probe.Method = "GET";
                probe.Proxy = null; // 回环探测绝不能走系统代理（Clash 等会拦），否则身份校验永远失败
                using (WebResponse resp = probe.GetResponse())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    if (sr.ReadToEnd().IndexOf(HostVersion, StringComparison.Ordinal) < 0) return 0;
                }
            }
            catch { return 0; }
            return port;
        }
        catch { return 0; }
    }

    /// <summary>启动管理后台。返回 true 表示端口由本进程持有。
    /// 若已有一个 host 实例在服务（比如扩展拉起的那个），直接复用它的端口，不覆盖 ui.port。</summary>
    private static bool StartUiServer()
    {
        try
        {
            Log("ui: startuiserver enter");
            int existing = ReadLiveUiPort();
            Log("ui: existing=" + existing);
            if (existing > 0)
            {
                _uiPort = existing;
                Log("ui server already on 127.0.0.1:" + existing + " (reuse)");
                return false;
            }

            Random rnd = new Random();
            for (int attempt = 0; attempt < 10; attempt++)
            {
                int port = rnd.Next(20000, 45000);
                HttpListener l = new HttpListener();
                l.Prefixes.Add("http://127.0.0.1:" + port + "/");
                try
                {
                    l.Start();
                    _uiListener = l;
                    _uiPort = port;
                    break;
                }
                catch
                {
                    try { l.Close(); } catch { }
                }
            }
            if (_uiListener == null || !_uiListener.IsListening) return false;

            // 令牌：32 字节随机，写成 64 位十六进制。只有本进程打开的页面需要它。
            byte[] tokenBytes = new byte[32];
            using (System.Security.Cryptography.RandomNumberGenerator rng =
                System.Security.Cryptography.RandomNumberGenerator.Create())
            {
                rng.GetBytes(tokenBytes);
            }
            StringBuilder tokenHex = new StringBuilder(64);
            for (int i = 0; i < tokenBytes.Length; i++) tokenHex.Append(tokenBytes[i].ToString("x2", CultureInfo.InvariantCulture));
            _uiToken = tokenHex.ToString();

            string tokenFile = UiTokenPath;
            string tokenTmp = tokenFile + ".tmp";
            try
            {
                File.WriteAllText(tokenTmp, _uiToken, new UTF8Encoding(false));
                if (File.Exists(tokenFile)) File.Replace(tokenTmp, tokenFile, null);
                else File.Move(tokenTmp, tokenFile);
            }
            catch (Exception ex) { Log("ui token write failed: " + ex.Message); }

            string portFile = Path.Combine(_root, "ui.port");
            string portTmp = portFile + ".tmp";
            File.WriteAllText(portTmp, _uiPort.ToString(CultureInfo.InvariantCulture), new UTF8Encoding(false));
            if (File.Exists(portFile)) File.Replace(portTmp, portFile, null);
            else File.Move(portTmp, portFile);

            Log("ui: bound " + _uiPort);
            _uiThread = new Thread(UiLoop);
            _uiThread.IsBackground = true;
            _uiThread.Start();
            Log("ui server on 127.0.0.1:" + _uiPort);
            Audit("ui-start", "port=" + _uiPort);
            return true;
        }
        catch (Exception ex)
        {
            Log("ui server failed: " + ex.Message);
            return false;
        }
    }

    private static void UiLoop()
    {
        while (_uiListener != null && _uiListener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = _uiListener.GetContext(); }
            catch { return; } // listener 被关（进程退出）

            try { HandleUi(ctx); }
            catch (Exception ex) { Log("ui error: " + ex.Message); }
        }
    }

    private static void HandleUi(HttpListenerContext ctx)
    {
        HttpListenerRequest req = ctx.Request;
        HttpListenerResponse res = ctx.Response;

        // DNS rebinding 防护：Host 必须是 127.0.0.1:<我们的端口>
        string hostHeader = req.Headers["Host"] ?? "";
        if (hostHeader != "127.0.0.1:" + _uiPort)
        {
            res.StatusCode = 403;
            byte[] deny = Encoding.UTF8.GetBytes("forbidden host");
            res.OutputStream.Write(deny, 0, deny.Length);
            res.OutputStream.Close();
            return;
        }

        // 跨源网页防护：浏览器跨源请求必带 Origin 或 Sec-Fetch-Site。
        //  - Origin 存在 → 必须正好是本站 origin；
        //  - Sec-Fetch-Site 存在 → 只允许 same-origin / none（地址栏直开）。
        //  两者都缺失（curl / 本机脚本）放行：同机进程本来就在信任边界内，native messaging 也不走这里。
        string origin = req.Headers["Origin"] ?? "";
        if (origin.Length > 0 && origin != "http://127.0.0.1:" + _uiPort)
        {
            Deny(res, "forbidden origin");
            return;
        }
        string fetchSite = req.Headers["Sec-Fetch-Site"] ?? "";
        if (fetchSite.Length > 0 && fetchSite != "same-origin" && fetchSite != "none")
        {
            Deny(res, "forbidden fetch site");
            return;
        }

        string path = req.Url.AbsolutePath;

        // 令牌校验：/api/port 只回端口与版本（供启动器探测「这个端口上是不是我们」），
        // 其余 API 一律要 X-LV-Token。缺令牌/错令牌直接 401，不再往下走。
        if (path.StartsWith("/api/", StringComparison.Ordinal) && path != "/api/port")
        {
            if (!TokenMatches(req.Headers["X-LV-Token"]))
            {
                res.StatusCode = 401;
                WriteJson(res, Error("ui-auth", "unauthorized",
                    "未授权的后台请求：请从桌面快捷方式或扩展重新打开本地后台"));
                return;
            }
        }

        if (path == "/" || path == "/index.html")
        {
            ServeUiPage(res);
            return;
        }

        if (path == "/argon2.js")
        {
            ServeArgon2(res);
            return;
        }

        // 独立 app 窗口的标签 / 任务栏图标，和扩展、桌面快捷方式保持一致
        if (path == "/favicon.svg" || path == "/favicon.ico")
        {
            ServeIcon(res);
            return;
        }

        if (path == "/api/port")
        {
            WriteJson(res, Ok("ui", new Dictionary<string, object>
            {
                { "port", _uiPort },
                { "version", HostVersion },
                { "proto", ProtoVersion }
            }));
            return;
        }

        if (path.StartsWith("/api/", StringComparison.Ordinal))
        {
            HandleApi(req, res, path.Substring(5));
            return;
        }

        res.StatusCode = 404;
        byte[] nf = Encoding.UTF8.GetBytes("not found");
        res.OutputStream.Write(nf, 0, nf.Length);
        res.OutputStream.Close();
    }

    /// <summary>令牌比较：定长逐字符异或累加，避免按字节提前返回泄露前缀。</summary>
    private static bool TokenMatches(string provided)
    {
        if (string.IsNullOrEmpty(_uiToken) || string.IsNullOrEmpty(provided)) return false;
        if (provided.Length != _uiToken.Length) return false;
        int diff = 0;
        for (int i = 0; i < _uiToken.Length; i++) diff |= provided[i] ^ _uiToken[i];
        return diff == 0;
    }

    /// <summary>把后台令牌交给扩展：本指令不在 HTTP 白名单里，只能经 native messaging 取。
    /// 扩展拿它拼 http://127.0.0.1:&lt;port&gt;/?t=… 打开后台。</summary>
    private static Dictionary<string, object> UiTokenForExtension()
    {
        if (string.IsNullOrEmpty(_uiToken)) throw new HostError("ui-not-ready", "本地后台未启动");
        return new Dictionary<string, object>
        {
            { "token", _uiToken },
            { "port", _uiPort }
        };
    }

    /// <summary>统一拒绝响应（403）。</summary>
    private static void Deny(HttpListenerResponse res, string reason)
    {
        res.StatusCode = 403;
        byte[] deny = Encoding.UTF8.GetBytes(reason);
        res.OutputStream.Write(deny, 0, deny.Length);
        res.OutputStream.Close();
    }

    /// <summary>HTTP 后台允许的指令白名单。
    /// v1 整包 read/write、diag、selftest 只留给 native messaging：
    ///  read/write 是迁移期接口，diag 泄漏路径与备份清单，selftest 对后台无必要。
    /// unlock-resume / unlock-tpm 也只在 native messaging：这两条能在没有主密码的情况下
    /// 让 host 拿到 DEK，只给浏览器扩展用，HTTP 一旦可选就等于给本机任意进程留了后门。
    /// 后台登录只有一条路：拿主密码派生的 DEK 调 unlock。</summary>
    private static readonly HashSet<string> HttpAllowedOps = new HashSet<string>(StringComparer.Ordinal)
    {
        "hello", "ping", "status", "lock", "unlock",
        "tpm-status", "tpm-enable", "tpm-disable",
        "get-export-mode", "set-export-mode", "list", "get-secret", "upsert", "delete",
        "set-site-name", "get-identities", "set-identities", "fetch-site-info",
        "fill", "audit-tail", "audit-raw", "audit-stats", "backup-before-migrate",
        "export-encrypted", "unlock-info"
    };

    private static void HandleApi(HttpListenerRequest req, HttpListenerResponse res, string op)
    {
        string id = "ui-" + Guid.NewGuid().ToString("N").Substring(0, 8);
        if (op == null || !HttpAllowedOps.Contains(op))
        {
            WriteJson(res, Error(id, "op-not-allowed", "此指令不允许通过后台 API 调用"));
            return;
        }

        // 只接受 POST（攻击模拟 A4）：浏览器的跨源 preflight 是 OPTIONS，
        // 若放行它会真实执行一次 op——比如 OPTIONS /api/lock 就能把用户会话锁掉。
        if (!string.Equals(req.HttpMethod, "POST", StringComparison.Ordinal))
        {
            res.StatusCode = 405;
            byte[] m = Encoding.UTF8.GetBytes("method not allowed");
            res.OutputStream.Write(m, 0, m.Length);
            res.OutputStream.Close();
            return;
        }

        // 请求体上限 2MB：Content-Length 预检 + 流式读取双重限制，
        // chunked（无 Content-Length）也不会先吃满内存再拒绝。
        const int MaxApiBody = 2 * 1024 * 1024;
        if (req.ContentLength64 > MaxApiBody)
        {
            WriteJson(res, Error(id, "too-large", "请求体过大（上限 2MB）"));
            return;
        }
        string requestJson;
        using (StreamReader r = new StreamReader(req.InputStream, Encoding.UTF8))
        {
            System.Text.StringBuilder sb = new System.Text.StringBuilder();
            char[] buf = new char[8192];
            int total = 0, n;
            while ((n = r.ReadBlock(buf, 0, buf.Length)) > 0)
            {
                total += n;
                if (total > MaxApiBody)
                {
                    WriteJson(res, Error(id, "too-large", "请求体过大（上限 2MB）"));
                    return;
                }
                sb.Append(buf, 0, n);
            }
            requestJson = sb.ToString();
        }
        if (string.IsNullOrEmpty(requestJson)) requestJson = "{}";

        Dictionary<string, object> merged;
        try
        {
            Dictionary<string, object> body = Json.Deserialize<Dictionary<string, object>>(requestJson) ?? new Dictionary<string, object>();
            merged = new Dictionary<string, object>(body);
        }
        catch
        {
            merged = new Dictionary<string, object>();
        }
        // 协议里 id 身兼两职（请求关联 + get-secret/delete 的条目 id）。
        // 不能覆盖请求体里的 id，否则后台「查看/删除条目」会找不到条目。
        // HTTP 请求-响应不需要关联 id，故用单独的 reqId 字段。
        merged["reqId"] = id;
        merged["op"] = op;
        merged["source"] = "ui"; // 让 Handle 知道来源是后台（审计用）

        string responseJson = Handle(Json.Serialize(merged));
        WriteJson(res, responseJson);

        // 审计：只记操作名与条目 id（响应里有也不记值）
        try
        {
            Dictionary<string, object> resp = Json.Deserialize<Dictionary<string, object>>(responseJson);
            bool ok = resp != null && Equals(resp["ok"], true);
            string entryId = null;
            if (op == "get-secret" || op == "delete") entryId = GetString(merged, "id");
            else if (merged.ContainsKey("entry")) entryId = GetString(AsDict(merged["entry"]), "id");
            string detail = "ok=" + (ok ? "1" : "0");
            if (!string.IsNullOrEmpty(entryId)) detail += " entry=" + entryId;
            if (!ok && resp != null) detail += " err=" + GetString(resp, "error");
            string safeOp = (op ?? "").Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
            if (safeOp.Length > 40) safeOp = safeOp.Substring(0, 40);
            Audit("ui:" + safeOp, detail);
        }
        catch { }
    }

    // 单一事实来源：CSP 只走响应头（<meta> 里 frame-ancestors 会被忽略，
    // 而且 meta 与 header 取交集，容易写出「自己把自己挡了」的策略）。
    // script-src 必须含 'self'（/argon2.js 是外部文件）与 'wasm-unsafe-eval'（Argon2 的 wasm）。
    private const string PageCsp =
        "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    private static void ApplyCommonHeaders(HttpListenerResponse res)
    {
        res.Headers["X-Content-Type-Options"] = "nosniff";
        res.Headers["Cache-Control"] = "no-store";
        res.Headers["Content-Security-Policy"] = PageCsp;
    }

    private static void WriteJson(HttpListenerResponse res, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        res.ContentType = "application/json; charset=utf-8";
        ApplyCommonHeaders(res);
        res.ContentLength64 = payload.Length;
        res.OutputStream.Write(payload, 0, payload.Length);
        res.OutputStream.Close();
    }

    private static void ServeArgon2(HttpListenerResponse res)
    {
        byte[] payload = Encoding.UTF8.GetBytes(Argon2Js);
        res.ContentType = "application/javascript; charset=utf-8";
        ApplyCommonHeaders(res);
        res.ContentLength64 = payload.Length;
        res.OutputStream.Write(payload, 0, payload.Length);
        res.OutputStream.Close();
    }

    private static void ServeIcon(HttpListenerResponse res)
    {
        byte[] payload = Encoding.UTF8.GetBytes(IconSvg);
        res.ContentType = "image/svg+xml; charset=utf-8";
        ApplyCommonHeaders(res);
        res.ContentLength64 = payload.Length;
        res.OutputStream.Write(payload, 0, payload.Length);
        res.OutputStream.Close();
    }

    /// <summary>后台状态：解锁态与扩展共享（同一 host 进程内的同一把 DEK）。</summary>
    /// <summary>host 可执行文件的构建时间：显示在页面上，避免「到底有没有更新」靠猜。</summary>
    private static string BuildStamp()
    {
        try
        {
            return File.GetLastWriteTime(
                System.Reflection.Assembly.GetExecutingAssembly().Location).ToString("MM-dd HH:mm");
        }
        catch { return "?"; }
    }

    private static Dictionary<string, object> UiStatus()
    {
        bool recovered;
        Dictionary<string, object> env = ReadEnvelopeSafe(out recovered);
        return new Dictionary<string, object>
        {
            { "state", IsUnlocked() ? "unlocked" : "locked" },
            { "hostOk", true },
            { "version", HostVersion },
            { "buildAt", BuildStamp() },
            { "proto", ProtoVersion },
            { "vaultPath", _dbPath },
            { "exists", File.Exists(_dbPath) },
            { "uiPort", _uiPort },
            { "revision", env == null ? 0 : GetInt(env, "revision") },
            { "updatedAt", env == null ? null : GetString(env, "updatedAt") },
            // 数据格式：解锁态才能看到 payload 明文里的 format（信封 format 恒为 v1，别用它判断）
            { "payloadFormat", CurrentPayloadFormat() },
            { "tpmEnabled", File.Exists(Path.Combine(_root, "tpm.wrapping")) }
        };
    }

    /// <summary>后台单页：无外部依赖、无 build 步骤。数据经 /api/* 同源 fetch。
    /// 视觉沿用「玻璃轻蓝」，但这是一个独立文件，改这里不影响扩展。</summary>
    private static void ServeUiPage(HttpListenerResponse res)
    {
        string html = Page;
        byte[] payload = Encoding.UTF8.GetBytes(html);
        res.ContentType = "text/html; charset=utf-8";
        ApplyCommonHeaders(res);
        res.ContentLength64 = payload.Length;
        res.OutputStream.Write(payload, 0, payload.Length);
        res.OutputStream.Close();
    }
}
