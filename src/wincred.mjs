/**
 * Windows Credential Manager (generic credentials) via advapi32, used for agy, which stores its login there
 * (target "gemini:antigravity"). Blobs are passed as base64; nothing is logged.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CS = `
using System; using System.Runtime.InteropServices;
public class CamCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredRead(string t, int type, int flags, out IntPtr c);
  [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredWrite(ref CREDENTIAL c, int flags);
  [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredDelete(string t, int type, int flags);
  [DllImport("advapi32")] static extern void CredFree(IntPtr p);
  public static string Read(string t) { IntPtr p; if (!CredRead(t, 1, 0, out p)) return ""; var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    var b = new byte[c.CredentialBlobSize]; if (c.CredentialBlobSize > 0) Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize); string u = c.UserName ?? ""; CredFree(p);
    return Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(u)) + ":" + Convert.ToBase64String(b); }
  public static bool Write(string t, string user, string b64) { var b = Convert.FromBase64String(b64); var c = new CREDENTIAL(); c.Type = 1; c.TargetName = t; c.UserName = user;
    c.Persist = 2; c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(Math.Max(1, b.Length)); if (b.Length > 0) Marshal.Copy(b, 0, c.CredentialBlob, b.Length);
    bool ok = CredWrite(ref c, 0); int e = Marshal.GetLastWin32Error(); Marshal.FreeHGlobal(c.CredentialBlob); if (!ok) throw new Exception("CredWrite failed, win32 error " + e); return ok; }
  public static bool Delete(string t) { return CredDelete(t, 1, 0); }
}`;

// A temp .ps1 (not stdin): PowerShell reads piped scripts line by line, which breaks the multi-line type definition.
function ps(script) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), `cam-cred-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.ps1`);
    fs.writeFileSync(file, `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CS}\n'@\n${script}\n`, { mode: 0o600 });
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => {
      try { fs.unlinkSync(file); } catch {}
      code === 0 && !err.trim() ? resolve(out.trim()) : reject(new Error(err.trim().split('\n')[0] || `powershell exit ${code}`));
    });
  });
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** { user, blob: Buffer } or null when the credential doesn't exist. */
export async function credRead(target) {
  const r = await ps(`[CamCred]::Read(${q(target)})`);
  if (!r) return null;
  const [u, b] = r.split(':');
  return { user: Buffer.from(u, 'base64').toString('utf8'), blob: Buffer.from(b || '', 'base64') };
}

export async function credWrite(target, user, blob) {
  const ok = await ps(`[CamCred]::Write(${q(target)}, ${q(user)}, ${q(Buffer.from(blob).toString('base64'))})`);
  if (!/True/i.test(ok)) throw new Error(`Could not write credential ${target}`);
}

export async function credDelete(target) {
  await ps(`[void][CamCred]::Delete(${q(target)})`);
}
