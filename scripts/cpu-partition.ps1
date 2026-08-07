# cpu-partition.ps1 — Windows Job Object CPU hard-cap.
# Caps the current process tree (self + children) at a fraction of TOTAL system CPU.
#   -Cores 0.1 -TotalCores 16 -> 0.1/16 = 0.625% of total -> rate units 62 (hundredths of %)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/cpu-partition.ps1 -Cores 0.1 -Command "node probe.mjs"
param(
  [double]$Cores = 0.1,
  [int]$TotalCores = 16,
  [string]$Command = "echo no-command"
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class CpuPartition {
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
        public uint ControlFlags;
        public uint CpuRate;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);

    public static int SetCpuCap(double cores, int totalCores, string command) {
        double pctOfTotal = (cores / totalCores) * 100.0;
        uint rate = (uint)Math.Max(1, Math.Round(pctOfTotal * 100.0));
        if (rate > 10000) rate = 10000;

        IntPtr hJob = CreateJobObjectW(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) {
            Console.Error.WriteLine("[partition] CreateJobObject failed err=" + Marshal.GetLastWin32Error());
            return 1;
        }

        // Build raw 8-byte buffer: [ControlFlags:uint][CpuRate:uint] to avoid struct-layout ambiguity.
        byte[] raw = new byte[8];
        BitConverter.GetBytes(0x1u | 0x4u).CopyTo(raw, 0); // ENABLE | HARD_CAP
        BitConverter.GetBytes(rate).CopyTo(raw, 4);
        IntPtr ptr = Marshal.AllocHGlobal(8);
        try {
            Marshal.Copy(raw, 0, ptr, 8);
            if (!SetInformationJobObject(hJob, 15, ptr, 8)) { // 15 = JobObjectCpuRateControlInformation
                Console.Error.WriteLine("[partition] SetInformationJobObject failed rate=" + rate + " err=" + Marshal.GetLastWin32Error());
                return 1;
            }
        } finally {
            Marshal.FreeHGlobal(ptr);
        }

        if (!AssignProcessToJobObject(hJob, GetCurrentProcess())) {
            Console.Error.WriteLine("[partition] AssignProcessToJobObject failed err=" + Marshal.GetLastWin32Error());
            return 1;
        }

        Console.WriteLine("[partition] cores=" + cores + " total=" + totalCores + " => " + pctOfTotal.ToString("F3") + "% of total => rate units " + rate + " (HARD_CAP)");

        var psi = new ProcessStartInfo("cmd.exe", "/c " + command);
        psi.UseShellExecute = false;
        var proc = Process.Start(psi);
        proc.WaitForExit();
        return proc.ExitCode;
    }
}
"@

$code = [CpuPartition]::SetCpuCap($Cores, $TotalCores, $Command)
exit $code
