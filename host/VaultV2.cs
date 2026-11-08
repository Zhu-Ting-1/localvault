// 保险库 v2 数据层：host 是唯一持有 DEK 并做解密的地方，扩展只按需取单条。
//   unlock      —— 接收扩展派生出的 DEK，用第一条 head 验证
//   lock        —— 立即清零
//   list        —— 只解 head（标题/账号/网址）
//   get-secret  —— 只解指定条目的 secret
// 外层信封 { format, revision, updatedAt, ciphertext }，ciphertext 是 v2 payload
// 的 JSON 文本（每条已单独加密）。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;

internal static partial class VaultHost
{
    private const string V2Format = "localvault/v2";

    /// <summary>payload 段的固定 AAD（与扩展 lib/vault.ts 的 PAYLOAD_AAD_PREFIX 一致）。
    /// 解密时用它重算，不再信任密文里自带的 aad 字段。</summary>
    private const string PayloadAad = "localvault-payload/v1";

    /// <summary>常用身份（注册页备选的手机号/邮箱）的 AAD。它不属于任何条目，单独一段。</summary>
    private const string IdentitiesAad = "localvault/v2/identities";

    /// <summary>解锁期间唯一的一份 DEK；锁定时必须清零。</summary>
    // DEK 在内存里**永远以 DPAPI 保护的密文**存在（CryptProtectMemory，绑定本进程），
    // 用时才解密出一份明文副本。这样内存扫描/转储按「32 字节高熵 AES 密钥」搜寻时，
    // 看到的只是 DPAPI 密文。这是提高门槛，不是安全边界——见 README。
    private static byte[] _dekVault;
    private static System.Runtime.InteropServices.GCHandle _dekPin;
    private static bool _dekPinned;
    private static readonly object _dekLock = new object(); // 清 DEK（空闲/锁定）与取 DEK 的互斥

    private sealed class HostError : Exception
    {
        public readonly string Code;
        public HostError(string code, string message) : base(message) { Code = code; }
    }

    // ---------------- 指令实现 ----------------

    private static Dictionary<string, object> UnlockV2(Dictionary<string, object> req)
    {
        string dekB64 = GetString(req, "dek");
        Audit("unlock", "method=dek");
        if (string.IsNullOrEmpty(dekB64)) throw new HostError("bad-request", "缺少 dek");

        byte[] dek;
        try { dek = Convert.FromBase64String(dekB64); }
        catch { throw new HostError("bad-request", "dek 不是合法 base64"); }
        if (dek.Length != 32) throw new HostError("bad-request", "dek 必须是 32 字节");

        Dictionary<string, object> ext = ReadExtensionEnvelope();
        if (ext == null)
        {
            Array.Clear(dek, 0, dek.Length);
            throw new HostError("no-vault", "保险库不存在或不可读");
        }

        // 解 payload 段：GCM tag 验证 DEK 是否正确。老库（v1 payload）也能解出明文，
        // 但里面没有 format=localvault/v2 → need-migrate。
        Dictionary<string, object> plain;
        int entryCount = 0;
        try
        {
            plain = DecryptPayloadSection(dek, ext);
        }
        catch (HostError)
        {
            Array.Clear(dek, 0, dek.Length);
            throw;
        }

        if (GetString(plain, "format") != V2Format)
        {
            Array.Clear(dek, 0, dek.Length);
            throw new HostError("need-migrate", "保险库是旧版格式：请用主密码解锁一次完成升级（升级后 Windows Hello 可继续使用）");
        }

        object[] entries = GetArray(plain, "entries");
        if (entries != null) entryCount = entries.Length;

        ClearDek();
        PinDek(dek); // 内部按 exportMode 决定是否写会话槽（strict 不写）

        return new Dictionary<string, object>
        {
            { "method", "dek" },
            { "entries", entryCount },
            { "version", HostVersion }
        };
    }

    private static Dictionary<string, object> LockV2()
    {
        Log("lock op received");
        Audit("lock", "");
        ClearDek();
        DeleteSlot(); // 显式锁定：槽也删（本进程持过钥匙才删得到；没持过 DeleteSlot 无副作用）
        return new Dictionary<string, object> { { "locked", true } };
    }

    private static Dictionary<string, object> ListV2()
    {
        byte[] dek = RequireDek();
        Dictionary<string, object> payload = ReadPayloadV2();
        object[] entries = GetArray(payload, "entries");
        List<object> heads = new List<object>();

        if (entries != null)
        {
            foreach (object raw in entries)
            {
                Dictionary<string, object> entry = AsDict(raw);
                Dictionary<string, object> head = ParseJsonDict(DecryptSealed(dek, entry, "head"));
                heads.Add(new Dictionary<string, object>
                {
                    { "id", GetString(entry, "id") },
                    { "title", GetString(head, "title") },
                    { "username", GetString(head, "username") },
                    { "urls", GetArray(head, "urls") },
                    { "createdAt", GetString(head, "createdAt") },
                    { "updatedAt", GetString(head, "updatedAt") },
                    { "description", GetString(head, "description") }
                });
            }
        }

        return new Dictionary<string, object> { { "entries", heads } };
    }

    private static Dictionary<string, object> GetSecretV2(Dictionary<string, object> req)
    {
        byte[] dek = RequireDek();
        string id = GetString(req, "id");
        Audit("read-secret", "entry=" + id);
        if (string.IsNullOrEmpty(id)) throw new HostError("bad-request", "缺少 id");

        Dictionary<string, object> payload = ReadPayloadV2();
        object[] entries = GetArray(payload, "entries");
        if (entries != null)
        {
            foreach (object raw in entries)
            {
                Dictionary<string, object> entry = AsDict(raw);
                if (GetString(entry, "id") != id) continue;
                Dictionary<string, object> secret = ParseJsonDict(DecryptSealed(dek, entry, "secret"));
                return new Dictionary<string, object>
                {
                    { "id", id },
                    { "password", GetString(secret, "password") },
                    { "passwordHistory", GetArray(secret, "passwordHistory") },
                    { "notes", GetString(secret, "notes") }
                };
            }
        }
        throw new HostError("not-found", "没有这个条目：" + id);
    }

    // ---------------- 导出包裹模式（meta.exportMode） ----------------
    //
    // 用户可选的「加密程度」（无 TPM 的机器也能用全部功能，只是保护等级不同）：
    //   'host'   默认。有 TPM：DPAPI-NG 包裹（换机解不开）；无 TPM：等价 none
    //   'none'   不加 TPM 包裹。保护层 = 主密码 + 恢复密钥（KEK 包裹），仍抗离线暴力破解
    //   'strict' TPM 包裹 + 会话密钥槽不落盘（SW 回收后需重新输主密码），内存暴露最小
    //
    // 注意：无论哪一档，条目本身始终是 AES-256-GCM 每条独立加密（v2），磁盘上永远没有明文。

    private static string GetExportMode(Dictionary<string, object> payload)
    {
        Dictionary<string, object> meta = payload == null ? null : AsDict(GetValue(payload, "meta"));
        string mode = meta == null ? null : GetString(meta, "exportMode");
        if (mode == "none" || mode == "host" || mode == "strict") return mode;
        return "host";
    }

    private static void SetExportModeInMeta(Dictionary<string, object> payload, string mode)
    {
        Dictionary<string, object> meta = AsDict(GetValue(payload, "meta"));
        if (meta == null) meta = new Dictionary<string, object>();
        meta["exportMode"] = mode;
        payload["meta"] = meta;
    }

    private static Dictionary<string, object> GetExportModeV2()
    {
        RequireDek();
        Dictionary<string, object> payload = ReadPayloadV2();
        return new Dictionary<string, object> { { "mode", GetExportMode(payload) } };
    }

    private static Dictionary<string, object> SetExportModeV2(Dictionary<string, object> req)
    {
        byte[] dek = RequireDek();
        string mode = GetString(req, "mode");
        if (mode != "none" && mode != "host" && mode != "strict")
        {
            throw new HostError("bad-request", "mode 必须是 host / none / strict");
        }

        using (AcquireLock(LockTimeoutMs))
        {
            Dictionary<string, object> payload = ReadPayloadV2Strict();
            SetExportModeInMeta(payload, mode);
            WritePayload(payload);
        }

        // 模式只决定「会话槽怎么处理」，绝不顺带创建/删除 Hello 密钥：
        // 那把密钥每次使用都要用户点系统确认框，只能在用户明确开启时创建，
        // 否则切换一下加密挡位就会莫名弹窗，甚至被当成卡死。
        if (mode == "strict" || mode == "none")
        {
            try { File.Delete(SlotPath); } catch { }
        }
        else if (mode == "host")
        {
            PinDek(dek); // 恢复默认行为：按当前策略重写会话槽
        }

        return new Dictionary<string, object> { { "mode", mode } };
    }

    // ---------------- 常用身份（注册页备选手机号/邮箱） ----------------
    //
    // 为什么放进保险库而不是继续留在扩展的 storage.local：
    // 密钥（DEK）已经不在扩展里了，扩展没法再加解密。放进 payload 的 meta 段，
    // 与条目同等强度（同一个 DEK、同一套 GCM），扩展只拿明文结果。

    private static Dictionary<string, object> GetIdentitiesV2()
    {
        byte[] dek = RequireDek();
        Dictionary<string, object> payload = ReadPayloadV2();
        Dictionary<string, object> meta = payload == null ? null : AsDict(GetValue(payload, "meta"));
        Dictionary<string, object> blob = meta == null ? null : AsDict(GetValue(meta, "identities"));

        if (blob == null) return new Dictionary<string, object> { { "identities", new object[0] } };

        Dictionary<string, object> obj = ParseJsonDict(DecryptMeta(dek, blob));
        return new Dictionary<string, object>
        {
            { "identities", GetArray(obj, "identities") ?? new object[0] }
        };
    }

    private static Dictionary<string, object> SetIdentitiesV2(Dictionary<string, object> req)
    {
        byte[] dek = RequireDek();
        object rawList;
        if (!req.TryGetValue("identities", out rawList) || rawList == null)
        {
            throw new HostError("bad-request", "缺少 identities");
        }

        Dictionary<string, object> box = new Dictionary<string, object>
        {
            { "identities", ConvArray(rawList) }
        };

        using (AcquireLock(LockTimeoutMs))
        {
            Dictionary<string, object> payload = ReadPayloadV2Strict();
            Dictionary<string, object> meta = AsDict(GetValue(payload, "meta"));
            if (meta == null) meta = new Dictionary<string, object>();
            meta["identities"] = SealMeta(dek, box);
            payload["meta"] = meta;

            int revision = WritePayload(payload);
            return new Dictionary<string, object> { { "revision", revision } };
        }
    }

    // ---------------- 内部工具 ----------------

    private static Dictionary<string, object> SealMeta(byte[] dek, Dictionary<string, object> obj)
    {
        byte[] nonce = new byte[12];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(nonce);

        byte[] aad = Encoding.UTF8.GetBytes(IdentitiesAad);
        byte[] plain = Encoding.UTF8.GetBytes(Json.Serialize(obj));

        byte[] body, tag;
        AesGcmCng.Encrypt(dek, nonce, aad, plain, out body, out tag);

        byte[] all = new byte[body.Length + tag.Length];
        Array.Copy(body, 0, all, 0, body.Length);
        Array.Copy(tag, 0, all, body.Length, tag.Length);

        return new Dictionary<string, object>
        {
            { "nonce", Convert.ToBase64String(nonce) },
            { "ct", Convert.ToBase64String(all) },
            { "aad", IdentitiesAad }
        };
    }

    private static byte[] DecryptMeta(byte[] dek, Dictionary<string, object> blob)
    {
        byte[] nonce = Convert.FromBase64String(GetString(blob, "nonce"));
        byte[] all = Convert.FromBase64String(GetString(blob, "ct"));
        if (all.Length < 16) throw new HostError("format", "meta 密文太短");

        int bodyLen = all.Length - 16;
        byte[] body = new byte[bodyLen];
        byte[] tag = new byte[16];
        Array.Copy(all, 0, body, 0, bodyLen);
        Array.Copy(all, bodyLen, tag, 0, 16);

        try
        {
            return AesGcmCng.Decrypt(dek, nonce, Encoding.UTF8.GetBytes(IdentitiesAad), body, tag);
        }
        catch (AesGcmCng.AesGcmException ex)
        {
            throw new HostError("corrupt", "常用身份解不开：0x" + ex.Status.ToString("X8"));
        }
    }

    /// <summary>字段长度上限：超限直接拒绝而不是截断，防静默丢数据。</summary>
    private static string ClampField(string s, int max, string what)
    {
        if (s == null) return "";
        if (s.Length > max) throw new HostError("bad-request", what + " 过长（上限 " + max + "）");
        return s;
    }

    /// <summary>安全取值（键不存在时返回 null，不抛异常）。</summary>
    private static object GetValue(Dictionary<string, object> dict, string key)
    {
        object value;
        if (dict == null || !dict.TryGetValue(key, out value)) return null;
        return value;
    }

    /// <summary>把任意可枚举转成 object[]（序列化时用）。</summary>
    private static object[] ConvArray(object value)
    {
        object[] arr = value as object[];
        if (arr != null) return arr;

        System.Collections.IEnumerable seq = value as System.Collections.IEnumerable;
        if (seq == null) return new object[0];

        List<object> list = new List<object>();
        foreach (object item in seq) list.Add(item);
        return list.ToArray();
    }

    private static byte[] RequireDek()
    {
        lock (_dekLock)
        {
            if (_dekVault == null) throw new HostError("locked", "保险库已锁定");
            byte[] plain = (byte[])_dekVault.Clone();
            try
            {
                if (!CryptUnprotectMemory(plain, (uint)plain.Length, CRYPTPROTECTMEMORY_SAME_PROCESS))
                {
                    Array.Clear(plain, 0, plain.Length);
                    throw new HostError("internal", "内存解保护失败");
                }
            }
            catch (HostError) { throw; }
            catch (Exception ex)
            {
                Array.Clear(plain, 0, plain.Length);
                throw new HostError("internal", "内存解保护异常：" + ex.Message);
            }
            return plain;
        }
    }

    /// <summary>调用方用完明文 DEK 后尽快归还：清零副本，让 GC 回收。
    /// 明文只应存在于本次调用期间（微秒~毫秒级），越短越好。</summary>
    private static void ReleaseDek(byte[] dek)
    {
        if (dek == null) return;
        try { RtlSecureZeroMemory(dek, new IntPtr(dek.Length)); }
        catch { Array.Clear(dek, 0, dek.Length); }
    }

    /// <summary>把 DEK 以 DPAPI 密文常驻，并真正固定内存页（GCHandle.Pinned + VirtualLock）。
    /// 之前直接 VirtualLock(byte[]) 在 GC 移动数组后就锁不住了，现在先固定再锁。
    ///  顺带写会话密钥槽：所有解锁路径统一在 PinDek 落槽，resume 与「本进程 DEK 丢失」的
    ///  自愈都依赖它。</summary>
    private static void PinDek(byte[] dek)
    {
      lock (_dekLock)
      {
        _dekVault = (byte[])dek.Clone();
        _dekPinned = false;
        try
        {
            if (!CryptProtectMemory(_dekVault, (uint)_dekVault.Length, CRYPTPROTECTMEMORY_SAME_PROCESS))
            {
                // 保护失败必须 fail-closed：否则内存里留下的是明文 DEK
                RtlSecureZeroMemory(_dekVault, new IntPtr(_dekVault.Length));
                throw new HostError("internal", "内存保护失败，拒绝以明文持有密钥");
            }
            _dekPin = System.Runtime.InteropServices.GCHandle.Alloc(
                _dekVault, System.Runtime.InteropServices.GCHandleType.Pinned);
            _dekPinned = VirtualLock(_dekPin.AddrOfPinnedObject(), new IntPtr(_dekVault.Length));
            if (!_dekPinned) Log("VirtualLock 失败（内存页可能被换出），错误码 " + Marshal_GetLastError());
        }
        catch (HostError) { throw; } // 内存保护失败必须冒泡，不能被吞成日志
        catch (Exception ex)
        {
            Log("PinDek 异常：" + ex.Message);
        }
        // strict 模式不落会话槽（SW 回收后要求重新输主密码——用记忆换暴露面最小化）
        try
        {
            Dictionary<string, object> payload = ReadPayloadV2();
            if (payload != null && GetExportMode(payload) != "strict") WriteSlot(dek);
        }
        catch { WriteSlot(dek); } // 读不到模式（如首解锁）时保守写槽，保证可用性
      }
    }

    private static void ClearDek()
    {
      lock (_dekLock)
      {
        if (_dekVault == null) return;
        try
        {
            // 直接清密文即可：覆盖之后无论原来是什么都是废数据
            RtlSecureZeroMemory(_dekVault, new IntPtr(_dekVault.Length));
        }
        catch
        {
            Array.Clear(_dekVault, 0, _dekVault.Length);
        }
        if (_dekPinned)
        {
            try { VirtualUnlock(_dekVault, new IntPtr(_dekVault.Length)); } catch { }
            _dekPinned = false;
        }
        try { if (_dekPin.IsAllocated) _dekPin.Free(); } catch { }
        _dekVault = null;
      }
    }

    /// <summary>是否已解锁（DEK 常驻于内存保护容器）。</summary>
    private static bool IsUnlocked()
    {
        return _dekVault != null;
    }

    /// <summary>保险库的真实数据格式（payload 明文里的 format）。锁定态返回 null。
    /// 注意：文件信封的 format 恒为 localvault/v1（文件格式），v2 只看这里。</summary>
    private static string CurrentPayloadFormat()
    {
        if (!IsUnlocked()) return null;
        byte[] dek = null;
        try
        {
            dek = RequireDek();
            // payload 段在内层扩展信封（外层文件信封的 ciphertext 里），不是 ReadEnvelopeSafe 的返回值
            Dictionary<string, object> ext = ReadExtensionEnvelope();
            if (ext == null) return null;
            Dictionary<string, object> plain = DecryptPayloadSection(dek, ext);
            return GetString(plain, "format");
        }
        catch (Exception ex) { Log("payload-format unavailable: " + ex.Message); return null; }
        finally { if (dek != null) Array.Clear(dek, 0, dek.Length); }
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualLock(byte[] lpAddress, IntPtr dwSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualUnlock(byte[] lpAddress, IntPtr dwSize);

    // GCHandle.Pinned 固定地址版本：数组被 GC 移动前先固定，VirtualLock 才锁得住
    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualLock(IntPtr lpAddress, IntPtr dwSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualUnlock(IntPtr lpAddress, IntPtr dwSize);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "RtlSecureZeroMemory")]
    private static extern IntPtr RtlSecureZeroMemory(IntPtr ptr, IntPtr cnt);

    // ---- DPAPI（磁盘版，绑当前用户+机器）：会话槽 / 扩展「记住解锁」的包裹服务 ----

    private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct DataBlob { public int cbData; public System.IntPtr pbData; }

    [System.Runtime.InteropServices.DllImport("crypt32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern bool CryptProtectData(ref DataBlob pDataIn, string szDataDescr,
        IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DataBlob pCipherText);

    [System.Runtime.InteropServices.DllImport("crypt32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern bool CryptUnprotectData(ref DataBlob pDataIn, IntPtr ppszDataDescr,
        IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DataBlob pPlainText);

    /// <summary>DPAPI 包裹（绑当前用户+机器）。</summary>
    private static byte[] DpapiProtect(byte[] plain)
    {
        DataBlob input = new DataBlob { cbData = plain.Length };
        input.pbData = System.Runtime.InteropServices.Marshal.AllocHGlobal(plain.Length);
        try
        {
            System.Runtime.InteropServices.Marshal.Copy(plain, 0, input.pbData, plain.Length);
            DataBlob output = new DataBlob();
            if (!CryptProtectData(ref input, "LocalVault", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
                CRYPTPROTECT_UI_FORBIDDEN, ref output))
                throw new HostError("dpapi", "DPAPI 包裹失败：" + Marshal_GetLastError());
            try
            {
                byte[] blob = new byte[output.cbData];
                System.Runtime.InteropServices.Marshal.Copy(output.pbData, blob, 0, output.cbData);
                return blob;
            }
            finally { LocalFree(output.pbData); }
        }
        finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(input.pbData); }
    }

    private static byte[] DpapiUnprotect(byte[] blob)
    {
        DataBlob input = new DataBlob { cbData = blob.Length };
        input.pbData = System.Runtime.InteropServices.Marshal.AllocHGlobal(blob.Length);
        try
        {
            System.Runtime.InteropServices.Marshal.Copy(blob, 0, input.pbData, blob.Length);
            DataBlob output = new DataBlob();
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero,
                CRYPTPROTECT_UI_FORBIDDEN, ref output))
                throw new HostError("dpapi", "DPAPI 解包失败：" + Marshal_GetLastError());
            try
            {
                byte[] plain = new byte[output.cbData];
                System.Runtime.InteropServices.Marshal.Copy(output.pbData, plain, 0, output.cbData);
                return plain;
            }
            finally { LocalFree(output.pbData); }
        }
        finally { System.Runtime.InteropServices.Marshal.FreeHGlobal(input.pbData); }
    }

    /// <summary>dpapi-protect：给扩展「记住解锁」用——DEK 经 host 包一层 DPAPI 再落 storage.local。
    /// 仅 native messaging 可调（不在 HTTP 白名单里）。</summary>
    private static Dictionary<string, object> DpapiProtectV2(Dictionary<string, object> req)
    {
        RequireDek(); // 只在解锁态提供包裹服务
        string data = GetString(req, "data");
        if (string.IsNullOrEmpty(data)) throw new HostError("bad-request", "缺少 data");
        byte[] raw;
        try { raw = Convert.FromBase64String(data); }
        catch { throw new HostError("bad-request", "data 不是合法 base64"); }
        if (raw.Length > 256) { Array.Clear(raw, 0, raw.Length); throw new HostError("bad-request", "data 过长（上限 256 字节）"); }
        byte[] blob = DpapiProtect(raw);
        Array.Clear(raw, 0, raw.Length);
        Audit("dpapi-protect", "bytes=" + blob.Length);
        return new Dictionary<string, object> { { "data", Convert.ToBase64String(blob) } };
    }

    private static Dictionary<string, object> DpapiUnprotectV2(Dictionary<string, object> req)
    {
        string data = GetString(req, "data");
        if (string.IsNullOrEmpty(data)) throw new HostError("bad-request", "缺少 data");
        byte[] blob;
        try { blob = Convert.FromBase64String(data); }
        catch { throw new HostError("bad-request", "data 不是合法 base64"); }
        if (blob.Length > 512) throw new HostError("bad-request", "data 过长（上限 512 字节）");
        byte[] raw = DpapiUnprotect(blob);
        if (raw.Length > 256) { Array.Clear(raw, 0, raw.Length); throw new HostError("format", "解包内容异常"); }
        string result = Convert.ToBase64String(raw);
        Array.Clear(raw, 0, raw.Length);
        Audit("dpapi-unprotect", "");
        return new Dictionary<string, object> { { "data", result } };
    }

    // DPAPI 的「内存版」保护：绑定本进程，仅在本进程内可解。DEK 常驻时恒为密文。
    private const uint CRYPTPROTECTMEMORY_SAME_PROCESS = 0x00;

    [System.Runtime.InteropServices.DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CryptProtectMemory(byte[] pData, uint cbData, uint dwFlags);

    [System.Runtime.InteropServices.DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CryptUnprotectMemory(byte[] pData, uint cbData, uint dwFlags);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "RtlSecureZeroMemory")]
    private static extern void RtlSecureZeroMemory(byte[] ptr, IntPtr cnt);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern int GetLastError();

    private static int Marshal_GetLastError() { return GetLastError(); }

    /// <summary>读取并解析扩展信封（外层信封的 ciphertext 字段）。不是保险库返回 null。</summary>
    private static Dictionary<string, object> ReadExtensionEnvelope()
    {
        bool recovered;
        Dictionary<string, object> envelope = ReadEnvelopeSafe(out recovered);
        if (envelope == null) return null;

        string ciphertext = GetString(envelope, "ciphertext");
        if (string.IsNullOrEmpty(ciphertext) || ciphertext[0] != '{') return null;
        return ParseJsonDictOrNull(Encoding.UTF8.GetBytes(ciphertext));
    }

    /// <summary>用 DEK 解开扩展信封的 payload 段，返回内层明文 dict。
    /// GCM tag 本身就是 DEK 正确性的验证——解不开即 wrong-dek。</summary>
    private static Dictionary<string, object> DecryptPayloadSection(byte[] dek, Dictionary<string, object> ext)
    {
        Dictionary<string, object> section = AsDict(GetValue(ext, "payload"));
        if (section == null) throw new HostError("format", "扩展信封缺少 payload 段");

        byte[] nonce = Convert.FromBase64String(GetString(section, "nonce"));
        byte[] all = Convert.FromBase64String(GetString(section, "ct"));
        string aad = GetString(section, "aad");
        if (all.Length < 16) throw new HostError("format", "payload 段密文太短");

        int bodyLen = all.Length - 16;
        byte[] body = new byte[bodyLen];
        byte[] tag = new byte[16];
        Array.Copy(all, 0, body, 0, bodyLen);
        Array.Copy(all, bodyLen, tag, 0, 16);

        byte[] plain;
        try
        {
            plain = AesGcmCng.Decrypt(dek, nonce, Encoding.UTF8.GetBytes(PayloadAad), body, tag);
        }
        catch (AesGcmCng.AesGcmException)
        {
            // 历史数据兜底：极老的库曾用文件里的 aad 值（现在一律写 PayloadAad）
            if (string.IsNullOrEmpty(aad) || aad == PayloadAad)
                throw new HostError("wrong-dek", "这把钥匙打不开这个保险库");
            try { plain = AesGcmCng.Decrypt(dek, nonce, Encoding.UTF8.GetBytes(aad), body, tag); }
            catch (AesGcmCng.AesGcmException)
            {
                throw new HostError("wrong-dek", "这把钥匙打不开这个保险库");
            }
        }
        return ParseJsonDict(plain);
    }

    /// <summary>读取 v2 payload；不是 v2（老库/空库）返回 null。</summary>
    private static Dictionary<string, object> ReadPayloadV2()
    {
        byte[] dek = RequireDek();
        Dictionary<string, object> ext = ReadExtensionEnvelope();
        if (ext == null) return null;

        Dictionary<string, object> plain;
        try
        {
            plain = DecryptPayloadSection(dek, ext);
        }
        catch (HostError)
        {
            return null;
        }
        return GetString(plain, "format") == V2Format ? plain : null;
    }

    /// <summary>解开一个 SealedBlob：nonce 与 ct 都是 base64，ct 末尾 16 字节是 GCM tag。</summary>
    private static byte[] DecryptSealed(byte[] dek, Dictionary<string, object> entry, string kind)
    {
        string id = GetString(entry, "id");
        if (string.IsNullOrEmpty(id)) throw new HostError("format", "条目缺少 id");

        Dictionary<string, object> blob = AsDict(entry[kind]);
        if (blob == null) throw new HostError("format", "条目缺少 " + kind);

        byte[] nonce = Convert.FromBase64String(GetString(blob, "nonce"));
        byte[] all = Convert.FromBase64String(GetString(blob, "ct"));
        if (all.Length < 16) throw new HostError("format", kind + " 密文太短");

        int bodyLen = all.Length - 16;
        byte[] body = new byte[bodyLen];
        byte[] tag = new byte[16];
        Array.Copy(all, 0, body, 0, bodyLen);
        Array.Copy(all, bodyLen, tag, 0, 16);

        // AAD 由「当前位置 + 用途」重新算出来，密文里自带的 aad 字段一律忽略
        byte[] aad = Encoding.UTF8.GetBytes("localvault/v2/" + kind + "/" + id);
        try
        {
            return AesGcmCng.Decrypt(dek, nonce, aad, body, tag);
        }
        catch (AesGcmCng.AesGcmException ex)
        {
            throw new HostError("corrupt", kind + " 解不开（" + id + "）：0x" + ex.Status.ToString("X8"));
        }
    }

    private static Dictionary<string, object> ParseJsonDict(byte[] utf8)
    {
        Dictionary<string, object> dict = ParseJsonDictOrNull(utf8);
        if (dict == null) throw new HostError("format", "解密后的内容不是 JSON 对象");
        return dict;
    }

    private static Dictionary<string, object> ParseJsonDictOrNull(byte[] utf8)
    {
        try
        {
            return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(utf8));
        }
        catch
        {
            return null;
        }
    }

    private static Dictionary<string, object> AsDict(object raw)
    {
        return raw as Dictionary<string, object>;
    }

    /// <summary>取数组字段。JavaScriptSerializer 对数组可能给出 object[]、ArrayList 或 List&lt;object&gt;，
    /// 这里统一转成 object[] —— 之前只认 object[]，导致 entries 被当成"没有"。</summary>
    private static object[] GetArray(Dictionary<string, object> dict, string key)
    {
        object value;
        if (dict == null || !dict.TryGetValue(key, out value) || value == null) return null;

        object[] arr = value as object[];
        if (arr != null) return arr;

        System.Collections.IEnumerable seq = value as System.Collections.IEnumerable;
        if (seq == null) return null;

        List<object> list = new List<object>();
        foreach (object item in seq) list.Add(item);
        return list.ToArray();
    }

    // ---------------- 写入路径 ----------------

    private static Dictionary<string, object> UpsertV2(Dictionary<string, object> req)
    {
        byte[] dek = RequireDek();
        object rawEntry;
        if (!req.TryGetValue("entry", out rawEntry) || rawEntry == null) throw new HostError("bad-request", "缺少 entry");
        Dictionary<string, object> entry = AsDict(rawEntry);
        if (entry == null) throw new HostError("bad-request", "entry 不是对象");

        string id = GetString(entry, "id");
        if (string.IsNullOrEmpty(id)) throw new HostError("bad-request", "entry 缺少 id");
        if (id.Length > 128) throw new HostError("bad-request", "entry id 过长（上限 128）");

        object[] rawUrls = GetArray(entry, "urls") ?? new object[0];
        if (rawUrls.Length > 20) throw new HostError("bad-request", "urls 过多（上限 20）");
        List<object> cleanUrls = new List<object>();
        foreach (object o in rawUrls)
        {
            string s = Convert.ToString(o, CultureInfo.InvariantCulture) ?? "";
            if (s.Length > 2000) throw new HostError("bad-request", "url 过长（上限 2000）");
            cleanUrls.Add(s);
        }

        Dictionary<string, object> head = new Dictionary<string, object>
        {
            { "title", ClampField(GetString(entry, "title") ?? "", 300, "title") },
            { "username", ClampField(GetString(entry, "username") ?? "", 300, "username") },
            { "urls", cleanUrls.ToArray() },
            { "createdAt", GetString(entry, "createdAt") ?? Now() },
            { "updatedAt", Now() }
        };
        string newPassword = ClampField(GetString(entry, "password") ?? "", 4096, "password");

        using (AcquireLock(LockTimeoutMs))
        {
            Dictionary<string, object> payload = ReadPayloadV2Strict();
            List<object> list = new List<object>(GetArray(payload, "entries") ?? new object[0]);

            // 密码历史由 host 在锁内合并（v2 语义）：两个浏览器并发改同一条时，
            // 各自基于旧状态算出的 history 会互相覆盖——扩展侧算不可靠。
            List<object> mergedHistory = new List<object>();
            int index = -1;
            for (int i = 0; i < list.Count; i++)
            {
                if (GetString(AsDict(list[i]), "id") == id) { index = i; break; }
            }
            if (index >= 0)
            {
                Dictionary<string, object> prevSecret;
                try { prevSecret = ParseJsonDict(DecryptSealed(dek, AsDict(list[index]), "secret")); }
                catch { prevSecret = null; }
                if (prevSecret != null)
                {
                    string oldPassword = GetString(prevSecret, "password") ?? "";
                    foreach (object h in GetArray(prevSecret, "passwordHistory") ?? new object[0]) mergedHistory.Add(h);
                    foreach (object h in GetArray(entry, "passwordHistory") ?? new object[0]) mergedHistory.Add(h);
                    string oldUpdatedAt = "";
                    Dictionary<string, object> prevHead = ParseJsonDictOrNull(Encoding.UTF8.GetBytes("{}")) ?? new Dictionary<string, object>();
                    try { prevHead = ParseJsonDict(DecryptSealed(dek, AsDict(list[index]), "head")); } catch { }
                    oldUpdatedAt = GetString(prevHead, "updatedAt") ?? "";
                    if (oldPassword.Length > 0 && oldPassword != newPassword)
                    {
                        mergedHistory.Add(new Dictionary<string, object>
                        {
                            { "password", oldPassword },
                            { "changedAt", oldUpdatedAt }
                        });
                    }
                }
            }
            else
            {
                foreach (object h in GetArray(entry, "passwordHistory") ?? new object[0]) mergedHistory.Add(h);
            }

            // 密码历史只留最近 50 条，防库被历史撑大
            if (mergedHistory.Count > 50) mergedHistory.RemoveRange(0, mergedHistory.Count - 50);
            Dictionary<string, object> secret = new Dictionary<string, object>
            {
                { "password", newPassword },
                { "passwordHistory", mergedHistory.ToArray() },
                { "notes", ClampField(GetString(entry, "notes") ?? "", 8000, "notes") }
            };

            Dictionary<string, object> sealedEntry = new Dictionary<string, object>
            {
                { "id", id },
                { "head", SealJson(dek, id, "head", head) },
                { "secret", SealJson(dek, id, "secret", secret) }
            };

            if (index >= 0) list[index] = sealedEntry; else list.Add(sealedEntry);
        Audit("upsert", "entry=" + id + (index >= 0 ? " updated" : " created"));

            payload["entries"] = list.ToArray();
            int revision = WritePayload(payload);

            return new Dictionary<string, object>
            {
                { "id", id },
                { "revision", revision },
                { "created", index < 0 }
            };
        }
    }

    private static Dictionary<string, object> DeleteV2(Dictionary<string, object> req)
    {
        RequireDek();
        string id = GetString(req, "id");
        if (string.IsNullOrEmpty(id)) throw new HostError("bad-request", "缺少 id");
        Audit("delete", "entry=" + id);

        using (AcquireLock(LockTimeoutMs))
        {
            Dictionary<string, object> payload = ReadPayloadV2Strict();
            List<object> list = new List<object>(GetArray(payload, "entries") ?? new object[0]);
            int removed = list.RemoveAll(delegate(object o) { return GetString(AsDict(o), "id") == id; });
            if (removed == 0) throw new HostError("not-found", "没有这个条目：" + id);

            payload["entries"] = list.ToArray();
            int revision = WritePayload(payload);
            return new Dictionary<string, object> { { "id", id }, { "revision", revision } };
        }
    }

    /// <summary>set-site-name：只更新条目的中文站点名/描述，完全不碰 secret。
    /// 这样「批量补全中文名」不会产生大量「读取密码」审计，也不必把密码取出内存。</summary>
    private static Dictionary<string, object> SetSiteNameV2(Dictionary<string, object> req)
    {
        byte[] dek = RequireDek();
        string id = GetString(req, "id");
        string name = GetString(req, "name");
        string description = GetString(req, "description") ?? "";
        if (string.IsNullOrEmpty(id)) throw new HostError("bad-request", "缺少 id");
        if (string.IsNullOrEmpty(name)) throw new HostError("bad-request", "缺少 name");
        if (name.Length > 200) name = name.Substring(0, 200);
        if (description.Length > 500) description = description.Substring(0, 500);

        using (AcquireLock(LockTimeoutMs))
        {
            Dictionary<string, object> payload = ReadPayloadV2Strict();
            object[] entries = GetArray(payload, "entries") ?? new object[0];
            foreach (object raw in entries)
            {
                Dictionary<string, object> entry = AsDict(raw);
                if (entry == null || GetString(entry, "id") != id) continue;

                Dictionary<string, object> head = ParseJsonDict(DecryptSealed(dek, entry, "head"));
                head["title"] = name;
                if (description.Length > 0) head["description"] = description;
                entry["head"] = SealJson(dek, id, "head", head);
                payload["entries"] = entries;
                int revision = WritePayload(payload);
                Audit("site-name", "entry=" + id + " name=" + name);
                return new Dictionary<string, object>
                {
                    { "id", id }, { "name", name }, { "revision", revision }
                };
            }
        }
        throw new HostError("not-found", "没有这个条目：" + id);
    }

    /// <summary>把一条 head/secret 加密成 SealedBlob（ct = 密文 || 16 字节 tag）。</summary>
    private static Dictionary<string, object> SealJson(byte[] dek, string id, string kind, Dictionary<string, object> obj)
    {
        byte[] nonce = new byte[12];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(nonce);

        string aadText = "localvault/v2/" + kind + "/" + id;
        byte[] aad = Encoding.UTF8.GetBytes(aadText);
        byte[] plain = Encoding.UTF8.GetBytes(Json.Serialize(obj));

        byte[] body, tag;
        AesGcmCng.Encrypt(dek, nonce, aad, plain, out body, out tag);

        byte[] all = new byte[body.Length + tag.Length];
        Array.Copy(body, 0, all, 0, body.Length);
        Array.Copy(tag, 0, all, body.Length, tag.Length);

        return new Dictionary<string, object>
        {
            { "nonce", Convert.ToBase64String(nonce) },
            { "ct", Convert.ToBase64String(all) },
            { "aad", aadText }
        };
    }

    /// <summary>把 v2 payload 重新加密进 payload 段并写盘（读-改-写全程持锁）。
    ///  外层扩展信封的 kdf/wrappers/authVerify **原样保留**——改主密码不需要重写条目。</summary>
    private static int WritePayload(Dictionary<string, object> payload)
    {
        byte[] dek = RequireDek();
        Dictionary<string, object> ext = ReadExtensionEnvelope();
        if (ext == null) throw new HostError("no-vault", "保险库不存在");

        string aad = PayloadAad; // 统一固定 AAD，不再沿用文件里的值

        byte[] nonce = new byte[12];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider()) rng.GetBytes(nonce);
        byte[] plain = Encoding.UTF8.GetBytes(Json.Serialize(payload));

        byte[] body, tag;
        AesGcmCng.Encrypt(dek, nonce, Encoding.UTF8.GetBytes(aad), plain, out body, out tag);

        byte[] all = new byte[body.Length + tag.Length];
        Array.Copy(body, 0, all, 0, body.Length);
        Array.Copy(tag, 0, all, body.Length, tag.Length);

        ext["payload"] = new Dictionary<string, object>
        {
            { "nonce", Convert.ToBase64String(nonce) },
            { "ct", Convert.ToBase64String(all) },
            { "aad", aad }
        };

        return WriteExtEnvelope(ext);
    }

    /// <summary>把扩展信封写回外层 host 信封并落盘。返回新 revision。</summary>
    private static int WriteExtEnvelope(Dictionary<string, object> ext)
    {
        Dictionary<string, object> current = File.Exists(_dbPath) ? ReadEnvelope(_dbPath) : null;
        int revision = current == null ? 0 : GetInt(current, "revision");

        Dictionary<string, object> envelope = new Dictionary<string, object>
        {
            { "format", EnvelopeFormat },
            { "revision", revision + 1 },
            { "updatedAt", Now() },
            { "ciphertext", Json.Serialize(ext) }
        };
        WriteAtomic(Json.Serialize(envelope), false);
        return revision + 1;
    }

    /// <summary>在锁内读取且必须是 v2；用于写路径。</summary>
    private static Dictionary<string, object> ReadPayloadV2Strict()
    {
        Dictionary<string, object> payload = ReadPayloadV2();
        if (payload == null)
        {
            throw new HostError("need-migrate", "保险库还不是 v2 格式，需要先迁移");
        }
        return payload;
    }


    /// <summary>后台解锁的前置信息：只给 KDF 参数、验证段与包裹，
    /// 绝不含 payload 密文等业务数据。替代 read 在后台解锁流程里的角色。</summary>
    private static Dictionary<string, object> UnlockInfoV2()
    {
        bool recovered;
        Dictionary<string, object> envelope = ReadEnvelopeSafe(out recovered);
        if (envelope == null) return new Dictionary<string, object> { { "exists", false } };
        Dictionary<string, object> ext = ParseJsonDictOrNull(
            Encoding.UTF8.GetBytes(GetString(envelope, "ciphertext") ?? "")) ?? new Dictionary<string, object>();
        return new Dictionary<string, object>
        {
            { "exists", true },
            { "format", GetString(ext, "format") },
            { "revision", GetInt(envelope, "revision") },
            { "updatedAt", GetString(envelope, "updatedAt") },
            { "kdf", GetValue(ext, "kdf") },
            { "authVerify", GetValue(ext, "authVerify") },
            { "wrappers", GetValue(ext, "wrappers") }
        };
    }

    /// <summary>导出加密备份（后台「加密备份」按钮用）。需要解锁态。
    /// 替代 v1 的 read 指令——read 不在 HTTP 白名单里。</summary>
    private static Dictionary<string, object> ExportEncryptedV2()
    {
        RequireDek();
        Dictionary<string, object> ext = ReadExtensionEnvelope();
        if (ext == null) throw new HostError("no-vault", "保险库不存在");
        Dictionary<string, object> current = File.Exists(_dbPath) ? ReadEnvelope(_dbPath) : null;
        Audit("export-encrypted", "bytes=" + (current == null ? 0 : (GetString(current, "ciphertext") ?? "").Length));
        return new Dictionary<string, object>
        {
            { "exists", true },
            { "revision", current == null ? 0 : GetInt(current, "revision") },
            { "ciphertext", Json.Serialize(ext) },
            { "updatedAt", current == null ? null : GetString(current, "updatedAt") }
        };
    }

    /// <summary>迁移前备份：把当前 vault.db 原样复制一份，返回备份路径。
    /// 强制的：v0.2.x 读不懂 v2，没有这份备份就等于"升级不可逆"。</summary>
    private static Dictionary<string, object> BackupBeforeMigrateV2()
    {
        if (!File.Exists(_dbPath)) throw new HostError("no-vault", "保险库不存在");
        using (AcquireLock(LockTimeoutMs))
        {
            string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
            string target = _dbPath + ".pre-v2-" + stamp;
            File.Copy(_dbPath, target, true);
            Log("pre-v2 backup: " + target);
            return new Dictionary<string, object>
            {
                { "path", target },
                { "bytes", new FileInfo(target).Length }
            };
        }
    }


    // stdin 关闭（浏览器回收 service worker）时，把 DEK 写进会话密钥槽 session.key
    //（权限与 vault.db 相同）。扩展侧恢复后调 unlock-resume：读槽 → 恢复钥匙 → 删槽。
    // 槽只在本机、只在浏览器会话期间存在；等于「记住解锁」，范围更小。

    private static void OnStdinClosed()
    {
        // 注意：实测浏览器（Edge/Chrome）在回收 SW / 关闭端口时是**直接 kill 进程**，
        // stdin 不会收到优雅的 EOF——这里通常不会执行。槽的写入因此改为
        // 「unlock 成功时同步写、lock 时删」（见 PinDek / ClearDek），进程被强杀也能保住钥匙。
        ClearDek();
    }

    /// <summary>会话密钥槽路径。</summary>
    private static string SlotPath
    {
        get { return Path.Combine(_root, "session.key"); }
    }

    /// <summary>解锁成功时把 DEK 写进槽（浏览器被强杀/SW 回收后的恢复依据）。
    /// 生命周期 = 浏览器会话：lock 时删除；与 v1 把 DEK 放 chrome.storage.session
    /// 的安全边界一致（都在本机磁盘、浏览器关闭即失效）。</summary>
    private static void WriteSlot(byte[] dek)
    {
        try
        {
            // DPAPI 包裹（绑当前用户+机器）：槽文件被拷走/备份泄露时不能直接当 DEK 用
            byte[] blob = DpapiProtect(dek);
            File.WriteAllBytes(SlotPath, blob);
            Log("slot written (dpapi, " + blob.Length + " bytes)");
        }
        catch (Exception ex)
        {
            Log("session slot write failed: " + ex.Message); // 写不进也不影响本次解锁
        }
    }

    private static void DeleteSlot()
    {
        try
        {
            if (File.Exists(SlotPath)) { File.Delete(SlotPath); Log("slot deleted"); }
        }
        catch (Exception ex) { Log("slot delete failed: " + ex.Message); }
    }

    /// <summary>SW 复活后恢复会话：读密钥槽、验证它仍能解开库，然后立刻删槽。</summary>
    private static Dictionary<string, object> UnlockResumeV2()
    {
        string slotPath = Path.Combine(_root, "session.key");
        if (!File.Exists(slotPath)) throw new HostError("no-session", "没有可恢复的会话");

        byte[] raw;
        try { raw = File.ReadAllBytes(slotPath); }
        catch (Exception ex) { throw new HostError("io", "密钥槽读取失败：" + ex.Message); }
        byte[] dek;
        try
        {
            dek = DpapiUnprotect(raw); // 新格式：DPAPI 包裹
        }
        catch
        {
            // 兼容旧明文槽（升级前写下的 32 字节裸 DEK）；resume 成功后 PinDek 会重写成新格式
            if (raw.Length == 32) dek = raw;
            else throw new HostError("format", "密钥槽格式异常");
        }
        try
        {
            if (dek.Length != 32) throw new HostError("format", "密钥槽长度异常");

            // 验证这把钥匙仍能解开库（文件可能被并发写坏/换库了）
            Dictionary<string, object> ext = ReadExtensionEnvelope();
            if (ext == null) throw new HostError("no-vault", "保险库不存在");
            Dictionary<string, object> plain = DecryptPayloadSection(dek, ext); // 解不开会抛 wrong-dek

            ClearDek();
            PinDek(dek);
            Audit("unlock", "method=resume");

            object[] entries = GetArray(plain, "entries");
            return new Dictionary<string, object>
            {
                { "resumed", true },
                { "entries", entries == null ? 0 : entries.Length },
                { "version", HostVersion }
            };
        }
        finally
        {
            // 槽不删：它是"本次浏览器会话"的恢复依据，可能在 SW 多次回收中被反复读取。
            // 删除时机 = lock（ClearDek）或下次 unlock 覆写。浏览器关闭后的残留
            // 由扩展侧 session 标志的消失来兜底（没有标志就不会 resume）。
        }
    }
}
