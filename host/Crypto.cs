// AES-256-GCM（走 Windows CNG / bcrypt.dll）。
//
// 为什么不用托管实现：.NET Framework 4.0 没有 AesGcm 类，而我们的 host 必须能用
// 系统自带的编译器直接构建（不装 SDK、不引 NuGet）。bcrypt.dll 是系统组件，P/Invoke 即可。
//
// 与浏览器侧（WebCrypto）必须**字节级一致**：同样的 key/nonce/aad/明文 → 同样的密文与 tag。
// 这一点由 Selftest() 里那三组"由 WebCrypto 生成"的基准向量保证。

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

internal static class AesGcmCng
{
    private const string BCRYPT_AES_ALGORITHM = "AES";
    private const string BCRYPT_CHAINING_MODE = "ChainingMode";
    private const string BCRYPT_CHAIN_MODE_GCM = "ChainingModeGCM";

    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    private static extern int BCryptOpenAlgorithmProvider(
        out IntPtr phAlgorithm, string pszAlgId, string pszImplementation, uint dwFlags);

    [DllImport("bcrypt.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    private static extern int BCryptSetProperty(
        IntPtr hObject, string pszProperty, byte[] pbInput, int cbInput, int dwFlags);

    [DllImport("bcrypt.dll", SetLastError = false)]
    private static extern int BCryptGenerateSymmetricKey(
        IntPtr hAlgorithm, out IntPtr phKey, IntPtr pbKeyObject, int cbKeyObject,
        IntPtr pbSecret, int cbSecret, int dwFlags);

    [DllImport("bcrypt.dll", SetLastError = false)]
    private static extern int BCryptEncrypt(
        IntPtr hKey, byte[] pbInput, int cbInput, ref AuthInfo pPaddingInfo,
        byte[] pbIV, int cbIV, byte[] pbOutput, int cbOutput, out int pcbResult, int dwFlags);

    [DllImport("bcrypt.dll", SetLastError = false)]
    private static extern int BCryptDecrypt(
        IntPtr hKey, byte[] pbInput, int cbInput, ref AuthInfo pPaddingInfo,
        byte[] pbIV, int cbIV, byte[] pbOutput, int cbOutput, out int pcbResult, int dwFlags);

    [DllImport("bcrypt.dll", SetLastError = false)]
    private static extern int BCryptDestroyKey(IntPtr hKey);

    [DllImport("bcrypt.dll", SetLastError = false)]
    private static extern int BCryptCloseAlgorithmProvider(IntPtr hAlgorithm, int dwFlags);

    /// <summary>BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO 的托管镜像（字段顺序与 native 一致）。</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct AuthInfo
    {
        public int cbSize;
        public int dwInfoVersion;
        public IntPtr pbNonce;
        public int cbNonce;
        public IntPtr pbAuthData;
        public int cbAuthData;
        public IntPtr pbTag;
        public int cbTag;
        public IntPtr pbMacContext;
        public int cbMacContext;
        public int cbAAD;
        public long cbData;
        public int dwFlags;
    }

    public sealed class AesGcmException : Exception
    {
        public readonly int Status;
        public AesGcmException(string message, int status) : base(message) { Status = status; }
    }

    /// <summary>加密。返回密文（不含 tag）与 16 字节 tag。</summary>
    public static void Encrypt(byte[] key, byte[] nonce, byte[] aad, byte[] plaintext,
        out byte[] ciphertext, out byte[] tag)
    {
        if (key == null || key.Length != 32) throw new ArgumentException("key 必须是 32 字节");
        if (nonce == null || nonce.Length == 0) throw new ArgumentException("nonce 不能为空");

        IntPtr hAlg = IntPtr.Zero, hKey = IntPtr.Zero;
        GCHandle gKey = default(GCHandle), gNonce = default(GCHandle), gAad = default(GCHandle), gTag = default(GCHandle);

        try
        {
            OpenAlg(out hAlg);
            // key 数组先 pin 再按指针传：避免调用期间被 GC 搬动产生明文副本
            gKey = GCHandle.Alloc(key, GCHandleType.Pinned);
            int status = BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0,
                gKey.AddrOfPinnedObject(), key.Length, 0);
            Check(status, "BCryptGenerateSymmetricKey");

            tag = new byte[16];
            byte[] aadBytes = aad ?? new byte[0];
            gNonce = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            gAad = GCHandle.Alloc(aadBytes, GCHandleType.Pinned);
            gTag = GCHandle.Alloc(tag, GCHandleType.Pinned);

            AuthInfo info = NewInfo(gNonce, nonce.Length, gAad, aadBytes.Length, gTag, 16, plaintext.Length);

            // GCM 是流模式：输入输出等长；空明文也只产生 tag
            byte[] input = plaintext.Length == 0 ? new byte[1] : plaintext;
            byte[] output = new byte[Math.Max(1, plaintext.Length)];
            int written;
            status = BCryptEncrypt(hKey, input, plaintext.Length, ref info, null, 0,
                output, plaintext.Length, out written, 0);
            Check(status, "BCryptEncrypt");

            if (written != plaintext.Length) throw new AesGcmException("密文长度异常", status);
            ciphertext = plaintext.Length == 0 ? new byte[0] : output;
        }
        finally
        {
            if (gTag.IsAllocated) gTag.Free();
            if (gAad.IsAllocated) gAad.Free();
            if (gNonce.IsAllocated) gNonce.Free();
            if (gKey.IsAllocated) gKey.Free();
            if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
            if (hAlg != IntPtr.Zero) BCryptCloseAlgorithmProvider(hAlg, 0);
        }
    }

    /// <summary>解密。tag 不匹配会抛 AesGcmException（Status=0xC000A002）。</summary>
    public static byte[] Decrypt(byte[] key, byte[] nonce, byte[] aad, byte[] ciphertext, byte[] tag)
    {
        if (key == null || key.Length != 32) throw new ArgumentException("key 必须是 32 字节");
        if (tag == null || tag.Length != 16) throw new ArgumentException("tag 必须是 16 字节");

        IntPtr hAlg = IntPtr.Zero, hKey = IntPtr.Zero;
        GCHandle gKey = default(GCHandle), gNonce = default(GCHandle), gAad = default(GCHandle), gTag = default(GCHandle);

        try
        {
            OpenAlg(out hAlg);
            gKey = GCHandle.Alloc(key, GCHandleType.Pinned);
            int status = BCryptGenerateSymmetricKey(hAlg, out hKey, IntPtr.Zero, 0,
                gKey.AddrOfPinnedObject(), key.Length, 0);
            Check(status, "BCryptGenerateSymmetricKey");

            byte[] aadBytes = aad ?? new byte[0];
            gNonce = GCHandle.Alloc(nonce, GCHandleType.Pinned);
            gAad = GCHandle.Alloc(aadBytes, GCHandleType.Pinned);
            gTag = GCHandle.Alloc(tag, GCHandleType.Pinned);

            AuthInfo info = NewInfo(gNonce, nonce.Length, gAad, aadBytes.Length, gTag, 16, ciphertext.Length);

            byte[] input = ciphertext.Length == 0 ? new byte[1] : ciphertext;
            byte[] output = new byte[Math.Max(1, ciphertext.Length)];
            int written;
            status = BCryptDecrypt(hKey, input, ciphertext.Length, ref info, null, 0,
                output, ciphertext.Length, out written, 0);
            Check(status, "BCryptDecrypt（tag 不匹配或密文被改动）");

            if (written != ciphertext.Length) throw new AesGcmException("明文长度异常", status);
            if (ciphertext.Length == 0) return new byte[0];
            Array.Resize(ref output, written);
            return output;
        }
        finally
        {
            if (gTag.IsAllocated) gTag.Free();
            if (gAad.IsAllocated) gAad.Free();
            if (gNonce.IsAllocated) gNonce.Free();
            if (gKey.IsAllocated) gKey.Free();
            if (hKey != IntPtr.Zero) BCryptDestroyKey(hKey);
            if (hAlg != IntPtr.Zero) BCryptCloseAlgorithmProvider(hAlg, 0);
        }
    }

    private static void OpenAlg(out IntPtr hAlg)
    {
        int status = BCryptOpenAlgorithmProvider(out hAlg, BCRYPT_AES_ALGORITHM, null, 0);
        Check(status, "BCryptOpenAlgorithmProvider");

        byte[] mode = Encoding.Unicode.GetBytes(BCRYPT_CHAIN_MODE_GCM + "\0");
        status = BCryptSetProperty(hAlg, BCRYPT_CHAINING_MODE, mode, mode.Length, 0);
        Check(status, "BCryptSetProperty(ChainingModeGCM)");
        // 密钥对象交给 CNG 自己分配（pbKeyObject=null）：省掉查 ObjectLength 的一步，
        // 也就不会踩「查询长度返回 STATUS_BUFFER_TOO_SMALL」这个坑。
    }

    private static AuthInfo NewInfo(GCHandle nonce, int nonceLen, GCHandle aad, int aadLen,
        GCHandle tag, int tagLen, long dataLen)
    {
        AuthInfo info = new AuthInfo();
        info.cbSize = Marshal.SizeOf(typeof(AuthInfo));
        info.dwInfoVersion = 1;
        info.pbNonce = nonce.AddrOfPinnedObject();
        info.cbNonce = nonceLen;
        info.pbAuthData = aadLen == 0 ? IntPtr.Zero : aad.AddrOfPinnedObject();
        info.cbAuthData = aadLen;
        info.pbTag = tag.AddrOfPinnedObject();
        info.cbTag = tagLen;
        info.cbAAD = aadLen;
        info.cbData = dataLen;
        return info;
    }

    private static void Check(int status, string what)
    {
        if (status < 0) throw new AesGcmException(what + " 失败（0x" + status.ToString("X8") + "）", status);
    }

    // ---------------- 基准向量（由 WebCrypto 生成，必须字节级一致） ----------------

    private sealed class Vector
    {
        public string Key, Nonce, Aad, Plain, Cipher, Tag;
        public Vector(string k, string n, string a, string p, string c, string t)
        { Key = k; Nonce = n; Aad = a; Plain = p; Cipher = c; Tag = t; }
    }

    private static readonly Vector[] Vectors = new Vector[]
    {
        new Vector(
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "AAAAAAAAAAAAAAAA",
            "localvault/v2/head/id-1",
            "eyJ0aXRsZSI6Iua3mOWunSJ9",
            "tYU0VDkMDkw9bCNkIhYzhVAd",
            "6U6hiQNhvM3tWTl0ZULQVA=="),
        new Vector(
            "//////////////////////////////////////////8=",
            "ASNFZ4mrze8BI0Vn",
            "",
            "",
            "",
            "ljp/JI3jeluvVuH9mHmaBg=="),
        new Vector(
            "obLD1OX2BxgpOktcbX6PkKGyw9Tl9gcYKTpLXG1+j5A=",
            "qrvM3e7/ABEiM0RV",
            "localvault/v2/secret/abc",
            "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA==",
            "xdNPX6QW5jycPqsicVGwFXvVlqBbmGXcjBSg58qn6OcD6t7sMmBc2G8QSOdD61UGIAIsmKKMJTncdT8966qCwKl54kf3TDypi9EVtaidViD1R2mrbF1fs7/bsgPtzl4hyIE7lg==",
            "0DruZou5T8ujTrPMhxwdEA=="),
    };

    /// <summary>自检：与 WebCrypto 的基准向量逐字节比对，并验证篡改会被拒绝。</summary>
    public static Dictionary<string, object> Selftest()
    {
        List<string> failures = new List<string>();
        int passed = 0;

        foreach (Vector v in Vectors)
        {
            try
            {
                byte[] key = Convert.FromBase64String(v.Key);
                byte[] nonce = Convert.FromBase64String(v.Nonce);
                byte[] aad = Encoding.UTF8.GetBytes(v.Aad);
                byte[] plain = Convert.FromBase64String(v.Plain);

                byte[] ct, tag;
                Encrypt(key, nonce, aad, plain, out ct, out tag);

                if (Convert.ToBase64String(ct) != v.Cipher) { failures.Add("密文不一致：" + v.Aad); continue; }
                if (Convert.ToBase64String(tag) != v.Tag) { failures.Add("tag 不一致：" + v.Aad); continue; }

                byte[] back = Decrypt(key, nonce, aad, Convert.FromBase64String(v.Cipher), Convert.FromBase64String(v.Tag));
                if (!BytesEqual(back, plain)) { failures.Add("解密结果不一致：" + v.Aad); continue; }

                byte[] bad = (byte[])tag.Clone();
                bad[0] ^= 0x01;
                bool rejected = false;
                try { Decrypt(key, nonce, aad, Convert.FromBase64String(v.Cipher), bad); }
                catch (AesGcmException) { rejected = true; }
                if (!rejected) { failures.Add("篡改 tag 没有被拒绝：" + v.Aad); continue; }

                passed++;
            }
            catch (Exception ex)
            {
                failures.Add("异常：" + ex.Message);
            }
        }

        Dictionary<string, object> result = new Dictionary<string, object>();
        result["ok"] = failures.Count == 0;
        result["passed"] = passed;
        result["vectors"] = Vectors.Length;
        result["failures"] = failures;
        return result;
    }

    private static bool BytesEqual(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }
}
