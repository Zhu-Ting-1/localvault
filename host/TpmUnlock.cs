// TPM/Windows Hello 解锁：把 DEK 用一把受「使用确认」保护的 CNG 密钥包裹。
//
// 为什么不用 NCryptProtectSecret(LOCAL=user)：那套 DPAPI-NG 描述符只绑定「当前用户 + 这台机器」，
// 解包是静默的——点「用 Windows Hello 解锁」既不弹指纹也不弹 PIN，安全性反而低于每次输主密码。
//
// 现在的做法：创建/打开一把持久化 RSA 密钥，给它设 NCRYPT_UI_POLICY（dwShowDialog=1），
// 每次用这把密钥解密 DEK 时由系统弹确认框（配置了 Windows Hello 的机器要指纹/PIN）。
// 密钥优先建在 TPM 里（Microsoft Platform Crypto Provider），失败退回软件 KSP。
// 弹不出确认框时**失败关闭**，让用户回主密码，绝不静默解包。
//
// 包裹对象存 root/tpm.wrapping：{ "v":2, "provider":…, "key":…, "wrapped": base64 }。
// v1 的旧文件（裸 DPAPI-NG blob）会被识别为 tpm-legacy，要求用主密码解锁后重新配置。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static partial class VaultHost
{
    private static string TpmWrappingPath
    {
        get { return Path.Combine(_root, "tpm.wrapping"); }
    }

    private const string TpmProvider = "Microsoft Platform Crypto Provider";
    private const string SoftProvider = "Microsoft Software Key Storage Provider";
    private const int NcryptPadPkcs1 = 0x00000004;
    private const int NcryptUiProtectKeyFlag = 0x00000001;
    private const int NcryptSilentFlag = 0x00000040;

    // ---------------- NCrypt P/Invoke ----------------

    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptOpenStorageProvider(out IntPtr phProvider, string pszProviderName, int dwFlags);

    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptCreatePersistedKey(IntPtr hProvider, out IntPtr phKey, string pszAlgId,
        string pszKeyName, int dwLegacyKeySpec, int dwFlags);

    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptOpenKey(IntPtr hProvider, out IntPtr phKey, string pszKeyName,
        int dwLegacyKeySpec, int dwFlags);

    [DllImport("ncrypt.dll", CharSet = CharSet.Unicode)]
    private static extern int NCryptSetProperty(IntPtr hObject, string pszProperty, byte[] pbInput,
        int cbInput, int dwFlags);

    [DllImport("ncrypt.dll")]
    private static extern int NCryptFinalizeKey(IntPtr hKey, int dwFlags);

    [DllImport("ncrypt.dll")]
    private static extern int NCryptEncrypt(IntPtr hKey, byte[] pbInput, int cbInput, IntPtr pPaddingInfo,
        byte[] pbOutput, int cbOutput, out int pcbResult, int dwFlags);

    [DllImport("ncrypt.dll")]
    private static extern int NCryptDecrypt(IntPtr hKey, byte[] pbInput, int cbInput, IntPtr pPaddingInfo,
        byte[] pbOutput, int cbOutput, out int pcbResult, int dwFlags);

    [DllImport("ncrypt.dll")]
    private static extern int NCryptDeleteKey(IntPtr hKey, int dwFlags);

    [DllImport("ncrypt.dll")]
    private static extern int NCryptFreeObject(IntPtr hObject);

    // DPAPI 路径（VaultV2 的 dpapi-protect/unprotect）共用这个释放函数
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    // ---------------- 指令实现 ----------------

    /// <summary>状态：本机能不能做「需确认」的解锁、当前是否已配置、密钥在 TPM 还是软件里。</summary>
    private static Dictionary<string, object> TpmStatus()
    {
        Dictionary<string, object> st = new Dictionary<string, object>
        {
            { "available", false },
            { "enabled", false },
            { "requiresUserPresence", true },
            { "confirmed", false },
            { "method", "none" },
            { "hardware", false }
        };

        Dictionary<string, object> saved = ReadTpmWrappingFile();
        if (saved != null)
        {
            string provider = GetString(saved, "provider") ?? SoftProvider;
            st["enabled"] = true;
            st["available"] = true;
            st["method"] = provider == TpmProvider ? "tpm" : "software";
            st["hardware"] = provider == TpmProvider;
            st["confirmed"] = saved.ContainsKey("confirmed") && Equals(saved["confirmed"], true);
            return st;
        }

        // 没配置过：只能报「这台机器有没有可用保护」。不创建任何密钥（避免探测动作留下垃圾）。
        bool hw = TpmProviderOpens();
        st["available"] = hw || SoftProviderOpens();
        st["method"] = hw ? "tpm" : (SoftProviderOpens() ? "software" : "none");
        st["hardware"] = hw;
        return st;
    }

    /// <summary>开启：新建一把带使用确认的密钥，把当前 DEK 包进去落盘。</summary>
    private static Dictionary<string, object> TpmEnable()
    {
        byte[] dek = RequireDek();
        DeleteSavedTpmKey(); // 换新密钥前清掉旧的，避免 TPM/用户配置里留一堆孤儿密钥

        string providerName = null;
        string keyName = StableKeyName();
        byte[] wrapped = null;

        foreach (string candidate in new[] { TpmProvider, SoftProvider })
        {
            try
            {
                wrapped = CreateKeyAndWrap(candidate, keyName, dek);
                providerName = candidate;
                break;
            }
            catch (HostError he)
            {
                if (he.Code == "tpm-cancelled") throw; // 用户取消不是「换个方案」的理由
                // 该提供程序不可用：换下一个
            }
        }
        if (wrapped == null || providerName == null)
        {
            throw new HostError("tpm-unavailable", "本机没有可用的密钥保护提供程序，无法开启需确认的解锁");
        }

        // 自检：用「禁止弹窗」的标志再解一次。只要系统真的在要确认，这次必须失败。
        // 成功说明这把密钥根本不要求人类在场——那就不要假装有 Hello 保护，直接拒绝开启。
        if (!SilentUnwrapRejected(providerName, keyName, wrapped))
        {
            try
            {
                IntPtr hp, hk;
                if (NCryptOpenStorageProvider(out hp, providerName, 0) == 0)
                {
                    if (NCryptOpenKey(hp, out hk, keyName, 0, 0) == 0) { NCryptDeleteKey(hk, 0); }
                    else NCryptFreeObject(hp);
                }
            }
            catch { }
            throw new HostError("tpm-ui-not-enforced",
                "这台电脑不会为这把密钥要求指纹/PIN，已取消开启（请改用主密码解锁）");
        }

        Dictionary<string, object> payload = new Dictionary<string, object>
        {
            { "v", 2 },
            { "provider", providerName },
            { "key", keyName },
            { "confirmed", true },
            { "wrapped", Convert.ToBase64String(wrapped) }
        };
        WriteBytesAtomic(TpmWrappingPath, Encoding.UTF8.GetBytes(Json.Serialize(payload)));
        Log("tpm wrapping enabled (" + wrapped.Length + " bytes, " + providerName + ")");
        Audit("tpm-enable", providerName == TpmProvider ? "method=tpm" : "method=software");

        return new Dictionary<string, object>
        {
            { "enabled", true },
            { "method", providerName == TpmProvider ? "tpm" : "software" },
            { "requiresUserPresence", true }
        };
    }

    private static Dictionary<string, object> TpmDisable()
    {
        RequireDek(); // 安全设置变更要求解锁态
        DeleteSavedTpmKey();
        try { File.Delete(TpmWrappingPath); } catch { }
        Audit("tpm-disable", "");
        return new Dictionary<string, object> { { "enabled", false } };
    }

    /// <summary>用受保护的密钥解锁：系统弹确认 → 解出 DEK → 验证能开库 → PinDek。</summary>
    private static Dictionary<string, object> UnlockTpmV2()
    {
        Audit("unlock", "method=tpm");
        if (!File.Exists(TpmWrappingPath))
        {
            throw new HostError("tpm-not-configured", "本机未开启 Windows Hello 解锁");
        }

        Dictionary<string, object> saved = ReadTpmWrappingFile();
        if (saved == null)
        {
            throw new HostError("tpm-legacy",
                "旧版 Hello 配置不含使用确认，已停用：请先用主密码解锁，再到设置里重新开启");
        }

        string providerName = GetString(saved, "provider") ?? SoftProvider;
        string keyName = GetString(saved, "key") ?? "";
        string b64 = GetString(saved, "wrapped") ?? "";
        byte[] wrapped;
        try { wrapped = Convert.FromBase64String(b64); }
        catch { throw new HostError("corrupt", "Hello 解锁配置损坏，请重新开启"); }

        byte[] dek = UnwrapWithKey(providerName, keyName, wrapped);
        if (dek == null || dek.Length != 32)
        {
            throw new HostError("corrupt", "解出的密钥长度异常");
        }

        // 验证这把 DEK 能解开当前库（换库/改主密码后包裹失效）
        Dictionary<string, object> ext = ReadExtensionEnvelope();
        if (ext == null)
        {
            Array.Clear(dek, 0, dek.Length);
            throw new HostError("no-vault", "保险库不存在");
        }
        Dictionary<string, object> plain;
        try { plain = DecryptPayloadSection(dek, ext); }
        catch (HostError he)
        {
            Array.Clear(dek, 0, dek.Length);
            if (he.Code == "wrong-dek")
            {
                throw new HostError("tpm-stale", "Hello 解锁配置与当前保险库不匹配，请用主密码解锁后重新开启");
            }
            throw;
        }
        if (GetString(plain, "format") != V2Format)
        {
            Array.Clear(dek, 0, dek.Length);
            throw new HostError("need-migrate", "保险库是旧版格式：请用主密码解锁一次完成升级");
        }

        ClearDek();
        PinDek(dek);

        object[] entries = GetArray(plain, "entries");
        return new Dictionary<string, object>
        {
            { "method", "tpm" },
            { "requiresUserPresence", true },
            { "entries", entries == null ? 0 : entries.Length },
            { "version", HostVersion }
        };
    }

    // ---------------- 密钥生命周期 ----------------

    private static byte[] CreateKeyAndWrap(string providerName, string keyName, byte[] dek)
    {
        IntPtr hProv = IntPtr.Zero, hKey = IntPtr.Zero;
        try
        {
            int status = NCryptOpenStorageProvider(out hProv, providerName, 0);
            Log("tpm: open provider " + providerName + " -> 0x" + Hex(status));
            if (status != 0) throw new HostError("tpm-unavailable", providerName + " 不可用 0x" + Hex(status));

            // 上一次中途取消可能留下同名半成品：先删掉再建
            IntPtr stale;
            if (NCryptOpenKey(hProv, out stale, keyName, 0, 0) == 0)
            {
                NCryptDeleteKey(stale, NcryptSilentFlag);
            }

            status = NCryptCreatePersistedKey(hProv, out hKey, "RSA", keyName, 0, 0);
            Log("tpm: create key -> 0x" + Hex(status));
            if (status != 0) throw new HostError("tpm-unavailable", "创建密钥失败 0x" + Hex(status));

            // 2048 位：够包裹 32 字节 DEK，TPM 2.0 普遍支持
            byte[] bits = BitConverter.GetBytes(2048);
            status = NCryptSetProperty(hKey, "Length", bits, bits.Length, 0);
            Log("tpm: set length -> 0x" + Hex(status));
            if (status != 0) throw new HostError("tpm-unavailable", "设置密钥长度失败 0x" + Hex(status));

            // 使用确认：每次用这把密钥都弹系统对话框（配置了 Hello 就要指纹/PIN）
            byte[] policy = BuildUiPolicy("LocalVault 解锁", "用这把密钥解开你的密码保险库");
            status = NCryptSetProperty(hKey, "UI Policy", policy, policy.Length, 0);
            Log("tpm: set ui policy -> 0x" + Hex(status));
            if (status != 0) throw new HostError("tpm-unavailable", "设置使用确认失败 0x" + Hex(status));

            status = NCryptFinalizeKey(hKey, 0);
            Log("tpm: finalize -> 0x" + Hex(status));
            if (status != 0) throw new HostError("tpm-unavailable", "密钥创建未完成 0x" + Hex(status));

            byte[] ct = EncryptWith(hKey, dek);
            Log("tpm: encrypt dek -> " + ct.Length + " bytes");
            return ct;
        }
        finally
        {
            if (hKey != IntPtr.Zero) NCryptFreeObject(hKey);
            if (hProv != IntPtr.Zero) NCryptFreeObject(hProv);
        }
    }

    private static byte[] UnwrapWithKey(string providerName, string keyName, byte[] wrapped)
    {
        if (string.IsNullOrEmpty(keyName)) throw new HostError("corrupt", "Hello 解锁配置缺少密钥名");
        IntPtr hProv = IntPtr.Zero, hKey = IntPtr.Zero;
        try
        {
            int status = NCryptOpenStorageProvider(out hProv, providerName, 0);
            if (status != 0) throw new HostError("tpm-unavailable", "密钥提供程序不可用 0x" + Hex(status));

            status = NCryptOpenKey(hProv, out hKey, keyName, 0, 0);
            if (status != 0)
            {
                if (status == unchecked((int)0x8009000D) || status == unchecked((int)0x80090011))
                {
                    throw new HostError("tpm-not-configured", "密钥已不存在（可能被系统清理）：请用主密码解锁后重新开启");
                }
                throw new HostError("tpm-unavailable", "打开密钥失败 0x" + Hex(status));
            }

            return DecryptWith(hKey, wrapped);
        }
        finally
        {
            if (hKey != IntPtr.Zero) NCryptFreeObject(hKey);
            if (hProv != IntPtr.Zero) NCryptFreeObject(hProv);
        }
    }

    /// <summary>用「禁止弹窗」标志尝试解包：真的要求确认的密钥一定失败。
    /// 返回 true = 被拒（符合预期）；false = 静默解开了（说明没有用户在场这道门）。</summary>
    private static bool SilentUnwrapRejected(string providerName, string keyName, byte[] wrapped)
    {
        IntPtr hProv = IntPtr.Zero, hKey = IntPtr.Zero;
        try
        {
            if (NCryptOpenStorageProvider(out hProv, providerName, 0) != 0) return false;
            if (NCryptOpenKey(hProv, out hKey, keyName, 0, 0) != 0) return false;

            int needed;
            int status = NCryptDecrypt(hKey, wrapped, wrapped.Length, IntPtr.Zero, null, 0, out needed,
                NcryptPadPkcs1 | NcryptSilentFlag);
            if (status != 0) return true; // UI 被拒 / 策略生效

            byte[] buf = new byte[needed];
            status = NCryptDecrypt(hKey, wrapped, wrapped.Length, IntPtr.Zero, buf, buf.Length, out needed,
                NcryptPadPkcs1 | NcryptSilentFlag);
            Array.Clear(buf, 0, buf.Length);
            return status != 0;
        }
        finally
        {
            if (hKey != IntPtr.Zero) NCryptFreeObject(hKey);
            if (hProv != IntPtr.Zero) NCryptFreeObject(hProv);
        }
    }

    /// <summary>删除 tpm.wrapping 里记着的那把密钥（换新/关闭时用）。</summary>
    private static void DeleteSavedTpmKey()
    {
        Dictionary<string, object> saved = ReadTpmWrappingFile();
        if (saved == null) return;
        string providerName = GetString(saved, "provider") ?? SoftProvider;
        string keyName = GetString(saved, "key") ?? "";
        if (string.IsNullOrEmpty(keyName)) return;

        IntPtr hProv = IntPtr.Zero, hKey = IntPtr.Zero;
        try
        {
            if (NCryptOpenStorageProvider(out hProv, providerName, 0) != 0) return;
            if (NCryptOpenKey(hProv, out hKey, keyName, 0, 0) != 0) return;
            NCryptDeleteKey(hKey, 0);
            hKey = IntPtr.Zero; // 已删除，句柄不再有效
        }
        catch { /* 删不掉不影响重设：新密钥会换名字 */ }
        finally
        {
            if (hKey != IntPtr.Zero) NCryptFreeObject(hKey);
            if (hProv != IntPtr.Zero) NCryptFreeObject(hProv);
        }
    }

    // ---------------- 加解密 + 错误映射 ----------------

    private static byte[] EncryptWith(IntPtr hKey, byte[] plain)
    {
        int needed;
        int status = NCryptEncrypt(hKey, plain, plain.Length, IntPtr.Zero, null, 0, out needed, NcryptPadPkcs1);
        if (status != 0) throw MapKeyError(status, "包裹密钥失败");
        byte[] outBuf = new byte[needed];
        status = NCryptEncrypt(hKey, plain, plain.Length, IntPtr.Zero, outBuf, outBuf.Length, out needed, NcryptPadPkcs1);
        if (status != 0) throw MapKeyError(status, "包裹密钥失败");
        if (needed == outBuf.Length) return outBuf;
        byte[] trimmed = new byte[needed];
        Array.Copy(outBuf, trimmed, needed);
        return trimmed;
    }

    private static byte[] DecryptWith(IntPtr hKey, byte[] wrapped)
    {
        int needed;
        int status = NCryptDecrypt(hKey, wrapped, wrapped.Length, IntPtr.Zero, null, 0, out needed, NcryptPadPkcs1);
        if (status != 0) throw MapKeyError(status, "解锁失败");
        byte[] outBuf = new byte[needed];
        status = NCryptDecrypt(hKey, wrapped, wrapped.Length, IntPtr.Zero, outBuf, outBuf.Length, out needed, NcryptPadPkcs1);
        if (status != 0) throw MapKeyError(status, "解锁失败");
        if (needed == outBuf.Length) return outBuf;
        byte[] trimmed = new byte[needed];
        Array.Copy(outBuf, trimmed, needed);
        return trimmed;
    }

    /// <summary>把 NCrypt 的 HRESULT 翻成 UI 能区分处理的错误码。</summary>
    private static HostError MapKeyError(int status, string what)
    {
        string hex = "0x" + Hex(status);
        if (status == unchecked((int)0x800704C7)) return new HostError("tpm-cancelled", "已取消确认");
        if (status == unchecked((int)0x80090036)) return new HostError("tpm-cancelled", "已取消确认");
        if (status == unchecked((int)0x80090029))
        {
            return new HostError("tpm-ui-unavailable",
                "系统无法弹出确认窗口（" + hex + "）：请用主密码解锁");
        }
        if (status == unchecked((int)0x8009000D) || status == unchecked((int)0x80090011))
        {
            return new HostError("tpm-not-configured", "密钥不存在，请重新配置 Hello 解锁");
        }
        if (status == unchecked((int)0x80090016))
        {
            return new HostError("tpm-not-configured", "本机密钥库不可用，请重新配置 Hello 解锁");
        }
        return new HostError("tpm-unprotect", what + " " + hex);
    }

    // ---------------- 辅助 ----------------

    /// <summary>读 tpm.wrapping。v1（裸 DPAPI-NG blob）返回 null，由调用方按 legacy 处理。</summary>
    private static Dictionary<string, object> ReadTpmWrappingFile()
    {
        try
        {
            if (!File.Exists(TpmWrappingPath)) return null;
            byte[] raw = File.ReadAllBytes(TpmWrappingPath);
            if (raw.Length == 0 || raw[0] != (byte)'{') return null; // v1
            string text = Encoding.UTF8.GetString(raw);
            Dictionary<string, object> d = Json.Deserialize<Dictionary<string, object>>(text);
            if (d == null) return null;
            object v;
            if (!d.TryGetValue("v", out v) || Convert.ToInt32(v, CultureInfo.InvariantCulture) != 2) return null;
            return d;
        }
        catch { return null; }
    }

    /// <summary>密钥名按数据目录推导：同一个安装永远是同一把，重开不会留一堆孤儿密钥。</summary>
    private static string StableKeyName()
    {
        string s = (_root ?? "").ToLowerInvariant();
        uint h = 2166136261;
        for (int i = 0; i < s.Length; i++) { h ^= s[i]; h *= 16777619; }
        return "LocalVault-" + h.ToString("x8", CultureInfo.InvariantCulture);
    }

    private static bool TpmProviderOpens()
    {
        IntPtr h;
        int status = NCryptOpenStorageProvider(out h, TpmProvider, 0);
        if (status == 0) { NCryptFreeObject(h); return true; }
        return false;
    }

    private static bool SoftProviderOpens()
    {
        IntPtr h;
        int status = NCryptOpenStorageProvider(out h, SoftProvider, 0);
        if (status == 0) { NCryptFreeObject(h); return true; }
        return false;
    }

    /// <summary>构造 NCRYPT_UI_POLICY：dwVersion=1、dwFlags=UI_PROTECT_KEY（使用时要确认）。</summary>
    private static byte[] BuildUiPolicy(string friendlyName, string description)
    {
        int size = 8 + IntPtr.Size * 3;
        IntPtr buf = Marshal.AllocHGlobal(size);
        IntPtr s1 = Marshal.StringToHGlobalUni(friendlyName);
        IntPtr s2 = Marshal.StringToHGlobalUni(description);
        try
        {
            Marshal.WriteInt32(buf, 0, 1);                      // dwVersion
            Marshal.WriteInt32(buf, 4, NcryptUiProtectKeyFlag); // dwFlags：显示对话框
            Marshal.WriteIntPtr(buf, 8, IntPtr.Zero);           // pszCreationTitle
            Marshal.WriteIntPtr(buf, 8 + IntPtr.Size, s1);      // pszFriendlyName
            Marshal.WriteIntPtr(buf, 8 + IntPtr.Size * 2, s2);  // pszDescription
            byte[] bytes = new byte[size];
            Marshal.Copy(buf, bytes, 0, size);
            return bytes;
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(s1);
            Marshal.FreeHGlobal(s2);
        }
    }

    private static string Hex(int status)
    {
        return status.ToString("X8", CultureInfo.InvariantCulture);
    }

    /// <summary>原子写：同目录临时文件 + 替换，避免半截文件被当成有效配置。</summary>
    private static void WriteBytesAtomic(string path, byte[] content)
    {
        string tmp = path + ".tmp";
        File.WriteAllBytes(tmp, content);
        if (File.Exists(path)) File.Replace(tmp, path, null);
        else File.Move(tmp, path);
    }
}
