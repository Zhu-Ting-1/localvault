// 站点名识别（零联网）+ 审计日志查询。
//
// FetchSiteInfo：只做两件事——内置常见站点映射、由调用方传入的页面标题清洗成站点名。
//   不发起任何网络请求（无 HttpWebRequest / 无 DNS）：「绝不联网」是产品承诺，
//   浏览器已经打开了那些页面，标题由扩展从标签页拿给 host，host 不自己上网。
//
// AuditTail：读 audit.log 尾部 N 行（默认 300）。
//   审计事件由各指令路径写入：哪些程序读了密码（扩展=ext / 后台=ui）、
//   填充次数（fill 事件）、增删改——全量、详细、不含明文。
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Globalization;

internal static partial class VaultHost
{
    // 常见站点中文名（零网络即答；覆盖不全的部分走在线抓取）
    private static readonly Dictionary<string, string> ZhSites = new Dictionary<string, string>
    {
        { "github.com", "GitHub 代码托管" },
        { "google.com", "谷歌搜索" },
        { "youtube.com", "YouTube 视频" },
        { "jd.com", "京东商城" },
        { "taobao.com", "淘宝" },
        { "tmall.com", "天猫" },
        { "pinduoduo.com", "拼多多" },
        { "bilibili.com", "哔哩哔哩" },
        { "weibo.com", "微博" },
        { "zhihu.com", "知乎" },
        { "qq.com", "腾讯 QQ" },
        { "163.com", "网易" },
        { "126.com", "网易邮箱" },
        { "aliyun.com", "阿里云" },
        { "baidu.com", "百度" },
        { "douyin.com", "抖音" },
        { "mi.com", "小米" },
        { "apple.com", "苹果" },
        { "microsoft.com", "微软" },
        { "office.com", "Office 365" },
        { "live.com", "微软账户" },
        { "ccb.com", "建设银行" },
        { "icbc.com", "工商银行" },
        { "cmbchina.com", "招商银行" },
        { "boc.cn", "中国银行" },
        { "abchina.com", "农业银行" },
        { "alipay.com", "支付宝" },
        { "cloud.tencent.com", "腾讯云" },
        { "steamcommunity.com", "Steam 社区" },
        { "steampowered.com", "Steam 游戏" },
        { "epicgames.com", "Epic 游戏" },
        { "notion.so", "Notion 笔记" },
        { "figma.com", "Figma 设计" },
        { "vercel.com", "Vercel 托管" },
        { "cloudflare.com", "Cloudflare" },
        { "amazon.com", "亚马逊" },
        { "openai.com", "OpenAI / ChatGPT" },
        { "anthropic.com", "Anthropic" },
    };

    private static string RootDomain(string host)
    {
        string[] parts = (host ?? "").Split('.');
        if (parts.Length <= 2) return host;
        string tld = parts[parts.Length - 1];
        string second = parts[parts.Length - 2];
        string[] twoLevel = { "com", "org", "net", "gov", "edu", "co" };
        if (second.Length <= 3 && Array.IndexOf(twoLevel, tld) >= 0)
        {
            return parts[parts.Length - 3] + "." + second + "." + tld;
        }
        return second + "." + tld;
    }

    /// <summary>查内置映射。命中返回中文名，未命中返回 null。</summary>
    private static string ZhSiteLookup(string url)
    {
        try
        {
            Uri u = new Uri(url.StartsWith("http", StringComparison.Ordinal) ? url : "https://" + url);
            string host = u.Host.ToLowerInvariant();
            string root = RootDomain(host);
            if (ZhSites.ContainsKey(host)) return ZhSites[host];
            if (ZhSites.ContainsKey(root)) return ZhSites[root];
        }
        catch { }
        return null;
    }

    /// <summary>fetch-site-info 指令：内置映射 + 调用方传入的页面标题。
/// title（可选）：扩展从浏览器标签页拿到的 document.title——浏览器本来就打开了那个页面，
/// 这样做零额外请求。host 自身绝不联网。</summary>
    private static Dictionary<string, object> FetchSiteInfo(Dictionary<string, object> req)
    {
        string url = GetString(req, "url");
        if (string.IsNullOrEmpty(url)) throw new HostError("bad-request", "缺少 url");
        string pageTitle = GetString(req, "title") ?? "";

        Dictionary<string, object> result = new Dictionary<string, object>();
        string zh = ZhSiteLookup(url);
        if (zh != null)
        {
            result["source"] = "builtin";
            result["name"] = zh;
            result["description"] = "";
            return result;
        }

        string host = HostOf(url);
        string name = IsUsableSiteName(pageTitle, host) ? CleanTitle(pageTitle) : "";
        result["source"] = name.Length > 0 ? "page-title" : "none";
        result["name"] = name;
        result["description"] = "";
        return result;
    }

    /// <summary>把页面标题清洗成站点名：取分隔符前的主段，去首尾空白。</summary>
    private static string CleanTitle(string title)
    {
        string t = title.Split(new[] { '|', '\u00b7', '\u2014', '\u2013', '-', '_', '\uff5c' })[0].Trim();
        return t.Length > 60 ? t.Substring(0, 60) : t;
    }


    /// <summary>通用错误页/登录页标题：不能当站点名（否则列表里会出现「404 Not Found」）。</summary>
    private static readonly Regex JunkTitle = new Regex(
        @"^(?:4\d\d|5\d\d|error|not\s*found|forbidden|access\s*denied|unauthorized|" +
        @"just\s*a\s*moment|attention\s*required|sign\s*in|log\s*in|login|loading|redirecting|" +
        @"页面不存在|页面未找到|访问受限|请登录|登录|错误)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>抓来的标题是否值得当站点名。</summary>
    private static bool IsUsableSiteName(string title, string host)
    {
        if (string.IsNullOrWhiteSpace(title)) return false;
        string t = title.Trim();
        if (t.Length < 2 || t.Length > 120) return false;
        if (!string.IsNullOrEmpty(host) && string.Equals(t, host, StringComparison.OrdinalIgnoreCase)) return false;
        if (JunkTitle.IsMatch(t)) return false;
        return true;
    }

    private static string HostOf(string url)
    {
        try { return new Uri(url).Host; } catch { return ""; }
    }

    /// <summary>解析一行审计记录。兼容旧的 3 列格式（没有来源列）。</summary>
    private static Dictionary<string, object> ParseAuditRow(string line)
    {
        if (string.IsNullOrEmpty(line)) return null;
        string[] p = line.Split('\t');
        if (p.Length >= 4)
        {
            return new Dictionary<string, object>
            {
                { "ts", p[0] }, { "source", p[1] }, { "action", p[2] },
                { "detail", string.Join(" ", p, 3, p.Length - 3) }
            };
        }
        if (p.Length == 3)
        {
            return new Dictionary<string, object>
            {
                { "ts", p[0] }, { "source", "legacy" }, { "action", p[1] }, { "detail", p[2] }
            };
        }
        return null;
    }

    private static void Inc(Dictionary<string, int> d, string k)
    {
        if (string.IsNullOrEmpty(k)) k = "(unknown)";
        int n;
        d.TryGetValue(k, out n);
        d[k] = n + 1;
    }

    /// <summary>汇总：读取/填充/写入/解锁次数，按来源与动作分组。
    /// 只统计核心业务事件，忽略 ui:* 这类「请求流水」行，避免重复计数。</summary>
    private static Dictionary<string, object> BuildAuditStats(string[] all)
    {
        Dictionary<string, int> byAction = new Dictionary<string, int>();
        Dictionary<string, int> bySource = new Dictionary<string, int>();
        int fills = 0, reads = 0, writes = 0, unlocks = 0, deletes = 0, fails = 0;
        string firstAt = null, lastAt = null;

        foreach (string line in all)
        {
            Dictionary<string, object> row = ParseAuditRow(line);
            if (row == null) continue;
            string ts = (string)row["ts"];
            string src = (string)row["source"];
            string act = (string)row["action"] ?? "";
            string detail = (string)row["detail"] ?? "";
            if (firstAt == null) firstAt = ts;
            lastAt = ts;

            // 只排除轮询类流水；ui:get-secret / ui:delete / ui:unlock 这些是真操作，必须计入
            if (RoutineAuditActions.Contains(act)) continue;
            Inc(byAction, act);
            if (!string.IsNullOrEmpty(src)) Inc(bySource, src);

            if (act.IndexOf("fill", StringComparison.OrdinalIgnoreCase) >= 0) fills++;
            if (act == "read-secret" || act == "ui:get-secret") reads++;
            if (act.IndexOf("upsert", StringComparison.OrdinalIgnoreCase) >= 0) writes++;
            if (act.IndexOf("unlock", StringComparison.OrdinalIgnoreCase) >= 0) unlocks++;
            if (act == "delete" || act == "ui:delete") deletes++;
            if (detail.IndexOf("ok=0", StringComparison.Ordinal) >= 0) fails++;
        }

        return new Dictionary<string, object>
        {
            { "total", all.Length },
            { "fills", fills },          // 用户点过多少次「填充」
            { "reads", reads },          // 密码被读取过多少次
            { "writes", writes },
            { "deletes", deletes },
            { "unlocks", unlocks },
            { "fails", fails },
            { "byAction", byAction },
            { "bySource", bySource },    // 哪个客户端读的（扩展 / 后台 / 各浏览器）
            { "firstAt", firstAt },
            { "lastAt", lastAt }
        };
    }

    /// <summary>fill 指令：扩展在用户点击「填充」时上报，记录站点/浏览器/方式。
    /// 只记元数据，绝不记密码本身。</summary>
    private static Dictionary<string, object> RecordFill(Dictionary<string, object> req)
    {
        string entryId = GetString(req, "entryId") ?? GetString(req, "id") ?? "";
        string site = GetString(req, "site") ?? "";
        string method = GetString(req, "method") ?? "click";
        string app = GetString(req, "app") ?? "";
        string tab = GetString(req, "tab") ?? "";
        if (site.Length > 200) site = site.Substring(0, 200);
        if (tab.Length > 120) tab = tab.Substring(0, 120);
        if (app.Length > 80) app = app.Substring(0, 80);

        Audit("fill", "entry=" + entryId + " site=" + site + " method=" + method
            + " app=" + app + " tab=" + tab);
        return new Dictionary<string, object> { { "recorded", true } };
    }

    private static Dictionary<string, object> AuditStats()
    {
        string[] all = File.Exists(AuditPath)
            ? File.ReadAllLines(AuditPath, new UTF8Encoding(false))
            : new string[0];
        return BuildAuditStats(all);
    }

    /// <summary>后台轮询类动作：默认在详细日志里折叠（不是安全事件，只会淹没真正有用的行）。</summary>
    private static readonly HashSet<string> RoutineAuditActions = new HashSet<string>(StringComparer.Ordinal)
    {
        "ui:status", "ui:list", "ui:tpm-status", "ui:get-export-mode", "ui:audit-tail",
        "ui:audit-stats", "ui:hello", "ui:ping", "ui:port", "ui:unlock-info",
        "ui:get-identities", "ui-start"
    };

    /// <summary>audit-tail 指令：按条件筛选 + 结构化行 + 统计（统计只算筛选后的范围）。
    /// 参数：lines（返回上限，默认 5000）；since/until（ISO 时间，闭区间）；
    /// src（来源筛选，精确，忽略大小写；注意不能叫 source——HTTP 层会把 source 覆盖成 ui）；
    /// fail=1 只看 ok=0；hideRoutine=1 折叠后台轮询流水。</summary>
    private static Dictionary<string, object> AuditTail(Dictionary<string, object> req)
    {
        int limit = 5000;
        object raw;
        if (req.TryGetValue("lines", out raw))
        {
            try { limit = Math.Max(10, Math.Min(5000, Convert.ToInt32(raw))); }
            catch { }
        }

        DateTime since, until;
        bool hasSince = TryParseUtc(GetString(req, "since"), out since);
        bool hasUntil = TryParseUtc(GetString(req, "until"), out until);
        string srcFilter = GetString(req, "src");
        string action = GetString(req, "action");
        string q = GetString(req, "q");
        bool failOnly = GetString(req, "fail") == "1";
        bool hideRoutine = GetString(req, "hideRoutine") == "1";

        if (!File.Exists(AuditPath))
        {
            return new Dictionary<string, object>
            {
                { "text", "" }, { "lines", 0 }, { "total", 0 }, { "matched", 0 },
                { "rows", new List<object>() },
                { "stats", BuildAuditStats(new string[0]) }
            };
        }

        string[] all = File.ReadAllLines(AuditPath, new UTF8Encoding(false));
        List<string> kept = new List<string>();
        List<object> rows = new List<object>();

        foreach (string line in all)
        {
            Dictionary<string, object> row = ParseAuditRow(line);
            if (row == null) continue;
            string ts = GetString(row, "ts");
            string src = GetString(row, "source") ?? "";
            string act = GetString(row, "action") ?? "";
            string detail = GetString(row, "detail") ?? "";

            if (hasSince || hasUntil)
            {
                DateTime t;
                if (!TryParseUtc(ts, out t)) continue;
                if (hasSince && t < since) continue;
                if (hasUntil && t > until) continue;
            }
            if (!string.IsNullOrEmpty(srcFilter) && !string.Equals(src, srcFilter, StringComparison.OrdinalIgnoreCase))
                continue;
            if (!string.IsNullOrEmpty(action) && !act.StartsWith(action, StringComparison.OrdinalIgnoreCase))
                continue;
            if (!string.IsNullOrEmpty(q)
                && (act + " " + detail).IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0)
                continue;
            if (failOnly && detail.IndexOf("ok=0", StringComparison.Ordinal) < 0) continue;
            if (hideRoutine && RoutineAuditActions.Contains(act)) continue;

            kept.Add(line);
            if (rows.Count < limit) rows.Add(row);
        }

        StringBuilder sb = new StringBuilder();
        int take = Math.Min(kept.Count, limit);
        for (int i = 0; i < take; i++) sb.AppendLine(kept[i]);

        return new Dictionary<string, object>
        {
            { "text", sb.ToString() },
            { "lines", take },
            { "total", all.Length },
            { "matched", kept.Count },
            { "rows", rows },
            { "stats", BuildAuditStats(kept.ToArray()) }
        };
    }

    /// <summary>整份 audit.log（「下载完整日志」用，不受筛选影响）。</summary>
    private static Dictionary<string, object> AuditRaw()
    {
        if (!File.Exists(AuditPath))
            return new Dictionary<string, object> { { "text", "" }, { "bytes", 0 } };
        FileInfo fi = new FileInfo(AuditPath);
        if (fi.Length > 8L * 1024 * 1024)
            throw new HostError("too-large", "审计日志超过 8MB，请直接打开 " + AuditPath);
        string text = File.ReadAllText(AuditPath, new UTF8Encoding(false));
        return new Dictionary<string, object> { { "text", text }, { "bytes", fi.Length } };
    }

    /// <summary>宽松解析 ISO 时间（带 Z 或偏移均可），统一成 UTC。</summary>
    private static bool TryParseUtc(string s, out DateTime utc)
    {
        utc = default(DateTime);
        if (string.IsNullOrEmpty(s)) return false;
        DateTime dt;
        if (!DateTime.TryParse(s, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out dt)) return false;
        utc = dt;
        return true;
    }

}
