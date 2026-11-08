// LocalVault native messaging host.
// Speaks the Chrome/Edge native messaging framing on stdin/stdout:
//   4-byte little-endian length + UTF-8 JSON.
// It NEVER decrypts, NEVER opens a socket, and NEVER logs secret material.
// Storage is one JSON envelope: { format, revision, updatedAt, ciphertext }.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class VaultHost
{
    // 与扩展 manifest 版本保持一致（app/wxt.config.ts 里那个）
    private const string HostVersion = "0.3.1";
    private const int ProtoVersion = 2;
    private const string EnvelopeFormat = "localvault-spike/v1";
    private const int MaxMessageBytes = 16 * 1024 * 1024;
    private const int LockTimeoutMs = 3000;

    private static readonly JavaScriptSerializer Json = CreateJson();
    private static string _root;
    private static string _dbPath;
    private static string _bakPath;
    private static string _lockPath;
    private static string _logPath;
    private static string _backupDir;

    private static JavaScriptSerializer CreateJson()
    {
        JavaScriptSerializer s = new JavaScriptSerializer();
        s.MaxJsonLength = int.MaxValue;
        s.RecursionLimit = 100;
        return s;
    }

    private static int Main(string[] args)
    {
        _root = Environment.GetEnvironmentVariable("LOCALVAULT_ROOT");
        if (string.IsNullOrEmpty(_root))
        {
            // 数据目录跟随安装目录（用户装到哪个盘，数据就在哪个盘）：
            //   <安装目录>\data\ —— 与 exe 同盘，卸载/升级不会碰它。
            // 显式设置 LOCALVAULT_ROOT 时优先用它（测试/高级用法）。
            string exeDir = Path.GetDirectoryName(
                System.Reflection.Assembly.GetExecutingAssembly().Location);
            if (string.IsNullOrEmpty(exeDir))
                exeDir = AppDomain.CurrentDomain.BaseDirectory;
            _root = Path.Combine(exeDir, "data");
        }

        _dbPath = Path.Combine(_root, "vault.db");
        _bakPath = Path.Combine(_root, "vault.db.bak");
        _lockPath = Path.Combine(_root, "vault.lock");
        _logPath = Path.Combine(_root, "host.log");
        _backupDir = Path.Combine(_root, "backups");

        try
        {
            Directory.CreateDirectory(_root);
            Directory.CreateDirectory(_backupDir);

            Stream stdin = Console.OpenStandardInput();
            Stream stdout = Console.OpenStandardOutput();
            bool uiOnly = Environment.GetEnvironmentVariable("LOCALVAULT_UI_ONLY") == "1";
            bool ownsUi = StartUiServer(); // 本地管理后台（127.0.0.1 随机端口，见 UiServer.cs）
            StartDekIdleWatch();          // 空闲自动清零 DEK（见 UiServer.cs）

            if (uiOnly)
            {
                // 双击 vault-ui.cmd 的独立后台模式：不读 native messaging，只保活 HTTP 服务。
                // 若已有实例在服务（扩展拉起的 host），本进程直接退出，端口仍由那个实例持有。
                if (!ownsUi) { Log("another host already serves the UI; exiting"); return 0; }
                Log("ui-only mode: http://127.0.0.1:" + _uiPort + "/");
                while (true) System.Threading.Thread.Sleep(1000);
            }

            while (true)
            {
                byte[] header = ReadExact(stdin, 4);
                if (header == null) { OnStdinClosed(); break; }
                int length = BitConverter.ToInt32(header, 0);
                if (length <= 0 || length > MaxMessageBytes)
                {
                    Log("bad message length: " + length);
                    break;
                }

                byte[] body = ReadExact(stdin, length);
                if (body == null) { OnStdinClosed(); break; }
                string response = Handle(Encoding.UTF8.GetString(body));
                WriteMessage(stdout, response);
            }
            return 0;
        }
        catch (Exception ex)
        {
            Log("fatal: " + ex);
            return 1;
        }
    }

    private static byte[] ReadExact(Stream stream, int count)
    {
        byte[] buffer = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int n = stream.Read(buffer, offset, count - offset);
            if (n <= 0) return null;
            offset += n;
        }
        return buffer;
    }

    private static void WriteMessage(Stream stdout, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        byte[] length = BitConverter.GetBytes(payload.Length);
        stdout.Write(length, 0, length.Length);
        stdout.Write(payload, 0, payload.Length);
        stdout.Flush();
    }

    private static string Handle(string requestJson)
    {
        string id = null;
        try
        {
            Dictionary<string, object> req =
                Json.Deserialize<Dictionary<string, object>>(requestJson);
            if (req == null) throw new InvalidDataException("empty request");

            // 后台 HTTP 用 reqId 做响应关联；native messaging 沿用 id（条目 id 会覆盖它）
            id = GetString(req, "reqId") ?? GetString(req, "id");
            string op = GetString(req, "op");
            TouchActivity(); // 刷新活动时间，阻止空闲自动清 DEK
            string source = GetString(req, "source") ?? "ext";
            // 审计来源白名单：防调用方冒充别人的来源
            if (source != "ext" && source != "ui" && source != "host") source = "ext";
            _auditSource = source; // 该请求产生的所有审计行都归属这个来源

            switch (op)
            {
                case "hello":
                    return Ok(id, Hello());
                case "status":
                    return Ok(id, UiStatus());
                case "ui-token":
                    return Ok(id, UiTokenForExtension());
                case "ping":
                    return Ok(id, new Dictionary<string, object>
                    {
                        { "pong", true },
                        { "utc", Now() }
                    });
                case "read":
                    return Ok(id, ReadVault());
                case "write":
                    return Ok(id, WriteVault(req));
                case "diag":
                    return Ok(id, Diagnose());
                case "selftest":
                    return Ok(id, Selftest());
                case "unlock":
                    return Ok(id, UnlockV2(req));
                case "lock":
                    return Ok(id, LockV2());
                case "unlock-resume":
                    return Ok(id, UnlockResumeV2());
                case "tpm-status":
                    return Ok(id, TpmStatus());
                case "get-export-mode":
                    return Ok(id, GetExportModeV2());
                case "set-export-mode":
                    return Ok(id, SetExportModeV2(req));
                case "tpm-enable":
                    return Ok(id, TpmEnable());
                case "tpm-disable":
                    return Ok(id, TpmDisable());
                case "unlock-tpm":
                    return Ok(id, UnlockTpmV2());
                case "list":
                    return Ok(id, ListV2());
                case "get-secret":
                    return Ok(id, GetSecretV2(req));
                case "upsert":
                    return Ok(id, UpsertV2(req));
                case "delete":
                    return Ok(id, DeleteV2(req));
                case "set-site-name":
                    return Ok(id, SetSiteNameV2(req));
                case "get-identities":
                    return Ok(id, GetIdentitiesV2());
                case "set-identities":
                    return Ok(id, SetIdentitiesV2(req));
                case "fetch-site-info":
                    return Ok(id, FetchSiteInfo(req));
                case "fill":
                    return Ok(id, RecordFill(req));
                case "audit-tail":
                    return Ok(id, AuditTail(req));
                case "audit-raw":
                    return Ok(id, AuditRaw());
                case "audit-stats":
                    return Ok(id, AuditStats());
                case "backup-before-migrate":
                    return Ok(id, BackupBeforeMigrateV2());
                case "export-encrypted":
                    return Ok(id, ExportEncryptedV2());
                case "unlock-info":
                    return Ok(id, UnlockInfoV2());
                case "dpapi-protect":
                    return Ok(id, DpapiProtectV2(req));
                case "dpapi-unprotect":
                    return Ok(id, DpapiUnprotectV2(req));
                default:
                    string safeOp = (op ?? "").Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
                    if (safeOp.Length > 40) safeOp = safeOp.Substring(0, 40);
                    return Error(id, "unknown_op", "unknown op: " + safeOp);
            }
        }
        catch (ConflictException conflict)
        {
            return Conflict(id, conflict.Current);
        }
        catch (HostError hostError)
        {
            Log("request rejected: " + hostError.Code + " " + hostError.Message);
            return Error(id, hostError.Code, hostError.Message);
        }
        catch (UnauthorizedAccessException ex)
        {
            // 目录只读 / 权限不足：明确告诉用户，别退化成「未知错误」
            Log("write denied: " + ex.Message);
            return Error(id, "readonly", "保险库目录不可写（只读或权限不足）：" + ex.Message);
        }
        catch (IOException ex)
        {
            bool full = IsDiskFull(ex);
            Log((full ? "disk full: " : "io error: ") + ex.Message);
            return Error(id, full ? "disk_full" : "io",
                full ? "磁盘空间不足，本次改动未保存" : "写入失败：" + ex.Message);
        }
        catch (Exception ex)
        {
            Log("request failed: " + ex.Message);
            return Error(id, "internal", ex.Message);
        }
    }

    /// <summary>磁盘写满在 Windows 上是 ERROR_DISK_FULL(112) / ERROR_HANDLE_DISK_FULL(39)。
    /// HResult 会被包成 0x8007xxxx；部分运行时只给本地化文案，所以文案也兜一层。</summary>
    private static bool IsDiskFull(IOException ex)
    {
        int hr = ex.HResult & 0xFFFF;
        if (hr == 112 || hr == 39) return true;
        string msg = ex.Message ?? "";
        return msg.IndexOf("disk full", StringComparison.OrdinalIgnoreCase) >= 0
            || msg.IndexOf("not enough space", StringComparison.OrdinalIgnoreCase) >= 0
            || msg.IndexOf("空间不足", StringComparison.Ordinal) >= 0
            || msg.IndexOf("磁盘已满", StringComparison.Ordinal) >= 0;
    }

    /// <summary>自检：验证二进制里的加密实现与 WebCrypto 基准向量一致。
    /// 只用固定向量、不接受调用方传密钥，所以不构成“加密预言机”，可以常开。</summary>
    private static Dictionary<string, object> Selftest()
    {
        return new Dictionary<string, object>
        {
            { "version", HostVersion },
            { "proto", ProtoVersion },
            { "crypto", AesGcmCng.Selftest() },
            { "utc", Now() }
        };
    }

    /// <summary>诊断信息：给扩展的「设置 / 诊断」页用。只读，不改任何东西。</summary>
    private static Dictionary<string, object> Diagnose()
    {
        bool recovered = false;
        Dictionary<string, object> envelope = null;
        string readError = null;
        try
        {
            envelope = ReadEnvelopeSafe(out recovered);
        }
        catch (Exception ex)
        {
            readError = ex.Message;
        }

        long size = 0;
        try { if (File.Exists(_dbPath)) size = new FileInfo(_dbPath).Length; } catch { }

        List<object> backups = new List<object>();
        int backupCount = 0;
        try
        {
            if (Directory.Exists(_backupDir))
            {
                FileInfo[] files = new DirectoryInfo(_backupDir).GetFiles("vault-*.db");
                backupCount = files.Length;
                Array.Sort(files, delegate(FileInfo a, FileInfo b)
                {
                    return b.LastWriteTimeUtc.CompareTo(a.LastWriteTimeUtc);
                });
                for (int i = 0; i < files.Length && i < 10; i++)
                {
                    backups.Add(new Dictionary<string, object>
                    {
                        { "name", files[i].Name },
                        { "bytes", files[i].Length },
                        { "utc", files[i].LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture) }
                    });
                }
            }
        }
        catch { }

        // 可写性探针：真正写一个字节再删掉，比看 ACL 可靠
        bool writable = false;
        string writeError = null;
        try
        {
            string probe = Path.Combine(_root, ".lv-write-probe");
            File.WriteAllText(probe, "1", new UTF8Encoding(false));
            File.Delete(probe);
            writable = true;
        }
        catch (Exception ex)
        {
            writeError = ex.Message;
        }

        long freeBytes = 0;
        try { freeBytes = new DriveInfo(Path.GetPathRoot(_root)).AvailableFreeSpace; } catch { }

        return new Dictionary<string, object>
        {
            { "version", HostVersion },
            { "proto", ProtoVersion },
            { "root", _root },
            { "vaultPath", _dbPath },
            { "tpmEnabled", TpmConfigured() },
            { "tpmLegacy", TpmLegacyOnDisk() },
            { "exists", File.Exists(_dbPath) },
            { "bytes", size },
            { "revision", envelope == null ? 0 : GetInt(envelope, "revision") },
            { "updatedAt", envelope == null ? null : GetString(envelope, "updatedAt") },
            { "recoveredFromBackup", recovered },
            { "readError", readError },
            { "writable", writable },
            { "writeError", writeError },
            { "freeBytes", freeBytes },
            { "backupCount", backupCount },
            { "backups", backups },
            { "logPath", _logPath },
            { "lockTimeoutMs", LockTimeoutMs },
            { "utc", Now() }
        };
    }

    private static Dictionary<string, object> Hello()
    {
        bool recovered;
        Dictionary<string, object> envelope = ReadEnvelopeSafe(out recovered);
        int revision = envelope == null ? 0 : GetInt(envelope, "revision");

        return new Dictionary<string, object>
        {
            { "version", HostVersion },
            { "proto", ProtoVersion },
            { "vaultPath", _dbPath },
            { "exists", envelope != null },
            { "revision", revision },
            { "recoveredFromBackup", recovered },
            { "pid", Process.GetCurrentProcess().Id },
            { "utc", Now() }
        };
    }

    private static Dictionary<string, object> ReadVault()
    {
        bool recovered;
        Dictionary<string, object> envelope = ReadEnvelopeSafe(out recovered);
        if (envelope == null)
        {
            return new Dictionary<string, object>
            {
                { "exists", false },
                { "revision", 0 },
                { "ciphertext", null },
                { "recoveredFromBackup", false }
            };
        }

        return new Dictionary<string, object>
        {
            { "exists", true },
            { "revision", GetInt(envelope, "revision") },
            { "ciphertext", GetString(envelope, "ciphertext") },
            { "updatedAt", GetString(envelope, "updatedAt") },
            { "recoveredFromBackup", recovered }
        };
    }

    private static Dictionary<string, object> WriteVault(Dictionary<string, object> req)
    {
        string ciphertext = GetString(req, "ciphertext");
        if (ciphertext == null) throw new InvalidDataException("ciphertext is required");
        int baseRevision = GetInt(req, "baseRevision");

        using (AcquireLock(LockTimeoutMs))
        {
            Dictionary<string, object> current = null;
            bool healing = false;
            if (File.Exists(_dbPath))
            {
                try
                {
                    current = ReadEnvelope(_dbPath); // strict: do not silently write over corruption
                }
                catch (Exception ex)
                {
                    // 主文件坏了但备份还能读：以备份为基准继续写（自愈），
                    // 否则用户会卡在「每次保存都失败」的状态里出不来。
                    if (!File.Exists(_bakPath)) throw;
                    Log("main vault unreadable on write, healing from .bak: " + ex.Message);
                    current = ReadEnvelope(_bakPath);
                    healing = true;
                }
            }

            int currentRevision = current == null ? 0 : GetInt(current, "revision");
            if (baseRevision != currentRevision)
            {
                throw new ConflictException(current);
            }

            int nextRevision = currentRevision + 1;
            Dictionary<string, object> envelope = new Dictionary<string, object>
            {
                { "format", EnvelopeFormat },
                { "revision", nextRevision },
                { "updatedAt", Now() },
                { "ciphertext", ciphertext }
            };

            string text = Json.Serialize(envelope);
            WriteAtomic(text, healing);

            return new Dictionary<string, object>
            {
                { "revision", nextRevision },
                { "vaultPath", _dbPath },
                { "utc", Now() }
            };
        }
    }

    private static void WriteAtomic(string text, bool healingFromBackup)
    {
        string tmpPath = _dbPath + ".tmp";
        byte[] bytes = new UTF8Encoding(false).GetBytes(text);

        using (FileStream fs = new FileStream(
            tmpPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(bytes, 0, bytes.Length);
            fs.Flush(true);
        }

        // 自愈写入：主文件是坏的，绝不能让它把好的 .bak 顶掉（File.Replace 会把旧主文件写进 .bak）。
        // 先把坏文件改名留证，再直接落盘。
        if (healingFromBackup && File.Exists(_dbPath))
        {
            string corrupt = _dbPath + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
            try { File.Move(_dbPath, corrupt); }
            catch { try { File.Delete(_dbPath); } catch { } }
            Log("corrupt vault moved aside: " + corrupt);
        }

        if (File.Exists(_dbPath))
        {
            File.Replace(tmpPath, _dbPath, _bakPath, true);
        }
        else
        {
            File.Move(tmpPath, _dbPath);
        }

        CopyDailyBackup();
    }

    private static void CopyDailyBackup()
    {
        try
        {
            string daily = Path.Combine(
                _backupDir,
                "vault-" + DateTime.UtcNow.ToString("yyyyMMdd", CultureInfo.InvariantCulture) + ".db");
            if (!File.Exists(daily)) File.Copy(_dbPath, daily, true);

            string[] files = Directory.GetFiles(_backupDir, "vault-*.db");
            Array.Sort(files, StringComparer.Ordinal);
            for (int i = 0; i < files.Length - 10; i++)
            {
                File.Delete(files[i]);
            }
        }
        catch (Exception ex)
        {
            Log("backup failed: " + ex.Message);
        }
    }

    private static FileStream AcquireLock(int timeoutMs)
    {
        Stopwatch sw = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                return new FileStream(
                    _lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (IOException)
            {
                if (sw.ElapsedMilliseconds >= timeoutMs) throw;
                Thread.Sleep(50);
            }
        }
    }

    private static Dictionary<string, object> ReadEnvelopeSafe(out bool recovered)
    {
        recovered = false;
        if (File.Exists(_dbPath))
        {
            try
            {
                return ReadEnvelope(_dbPath);
            }
            catch (Exception ex)
            {
                Log("main vault unreadable: " + ex.Message);
            }
        }

        if (File.Exists(_bakPath))
        {
            try
            {
                Dictionary<string, object> envelope = ReadEnvelope(_bakPath);
                recovered = true;
                return envelope;
            }
            catch (Exception ex)
            {
                Log("backup vault unreadable: " + ex.Message);
            }
        }
        return null;
    }

    private static Dictionary<string, object> ReadEnvelope(string path)
    {
        string text = File.ReadAllText(path, Encoding.UTF8);
        Dictionary<string, object> envelope =
            Json.Deserialize<Dictionary<string, object>>(text);
        if (envelope == null) throw new InvalidDataException("empty envelope");

        string format = GetString(envelope, "format");
        if (format != EnvelopeFormat)
        {
            throw new InvalidDataException("unexpected format: " + format);
        }
        return envelope;
    }

    private static string Ok(string id, object data)
    {
        return Json.Serialize(new Dictionary<string, object>
        {
            { "id", id },
            { "ok", true },
            { "data", data }
        });
    }

    private static string Error(string id, string code, string message)
    {
        return Json.Serialize(new Dictionary<string, object>
        {
            { "id", id },
            { "ok", false },
            { "error", code },
            { "message", message }
        });
    }

    private static string Conflict(string id, Dictionary<string, object> current)
    {
        Dictionary<string, object> data = new Dictionary<string, object>
        {
            { "revision", current == null ? 0 : GetInt(current, "revision") },
            { "ciphertext", current == null ? null : GetString(current, "ciphertext") },
            { "updatedAt", current == null ? null : GetString(current, "updatedAt") }
        };
        return Json.Serialize(new Dictionary<string, object>
        {
            { "id", id },
            { "ok", false },
            { "error", "conflict" },
            { "message", "baseRevision does not match current revision" },
            { "data", data }
        });
    }

    private static string GetString(Dictionary<string, object> dict, string key)
    {
        object value;
        if (dict == null || !dict.TryGetValue(key, out value) || value == null) return null;
        return Convert.ToString(value, CultureInfo.InvariantCulture);
    }

    private static int GetInt(Dictionary<string, object> dict, string key)
    {
        object value;
        if (dict == null || !dict.TryGetValue(key, out value) || value == null) return 0;
        return Convert.ToInt32(value, CultureInfo.InvariantCulture);
    }

    private static string Now()
    {
        return DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
    }

    private const long LogMaxBytes = 256 * 1024; // 超过就轮转一份 host.log.1，避免日志无限长

    private static void Log(string message)
    {
        try
        {
            FileInfo fi = new FileInfo(_logPath);
            if (fi.Exists && fi.Length > LogMaxBytes)
            {
                string prev = _logPath + ".1";
                try
                {
                    if (File.Exists(prev)) File.Delete(prev);
                    File.Move(_logPath, prev);
                }
                catch
                {
                    // 轮转失败就继续往原文件写，日志不能影响协议
                }
            }
            string line = Now() + " " + message + Environment.NewLine;
            File.AppendAllText(_logPath, line, new UTF8Encoding(false));
        }
        catch
        {
            // logging must never break the protocol
        }
    }

    private sealed class ConflictException : Exception
    {
        public readonly Dictionary<string, object> Current;

        public ConflictException(Dictionary<string, object> current)
        {
            Current = current;
        }
    }
}