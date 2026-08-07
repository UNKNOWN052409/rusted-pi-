#!/usr/bin/env python3
"""Windowed code audit via pi-agent (stdin JSON mode).

Usage:
  python audit_file.py <file> [--model <model-id>] [--window <lines>] [--overlap <lines>]

Features:
  - Files > WINDOW lines are split into overlapping windows (default 60 lines, 5-line overlap)
    so structs/functions at boundaries are seen in full by at least one window.
  - Absolute line numbers: window line i == file line (start + i - 1).
  - Strict no-lie prompt: report EVERY issue with exact line numbers; CLEAR if clean;
    never invent issues; never skip issues.
  - MODEL env override / --model flag (default kilwa-grok-4.3/kilwa-grok-4.3;
    cross-check with longcat/longcat-flash or longcat/longcat-flash-thinking).
  - Output: file header, per-window findings, severity summary, total elapsed time.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

WINDOW_DEFAULT = 60
OVERLAP_DEFAULT = 5

STRICT_PROMPT = """You are a code auditor. Audit the given section of a Rust file LINE BY LINE.

File: {filename} (absolute lines {start}-{end}, shown as 1-{shown})
The numbered lines below are lines {start}-{end} of the file. When you cite a line,
cite the ABSOLUTE file line number (shown in the [N] prefix).

Check for:
1. Missing derives (Clone, Copy, Debug, PartialEq, Default, Serialize, Deserialize)
2. Unused fields / dead code
3. Missing serde attributes (skip_serializing_if, rename)
4. Type safety issues (String vs &str, u32 vs usize, HashMap misuse)
5. Logic errors (wrong enum variants, edge cases, off-by-one)
6. Panic paths, byte-slicing on non-ASCII, unsafe code
7. Compiler warnings this section would produce

Rules (STRICT - never lie or cheat):
- Report EVERY issue with its EXACT absolute line number and severity (HIGH/MEDIUM/LOW).
- If a section is clean, reply exactly: CLEAR
- NEVER invent, guess, or repeat issues that are not present in the code.
- NEVER skip a real issue to look good.
- Only report issues you can point to in the provided lines.

SECTION:
{section}"""


def window_lines(lines, start, end):
    """Return a numbered string of lines[start:end] with absolute line numbers."""
    out = []
    for i in range(start, end):
        # absolute file line = i+1 (lines is 0-indexed)
        out.append(f"[{i + 1}] {lines[i]}")
    return "\n".join(out)


def run_audit_window(filepath, filename, lines, start, end, model):
    """Audit one window via pi-agent stdin mode. Returns (ok, text)."""
    section = window_lines(lines, start, end)
    prompt = STRICT_PROMPT.format(
        filename=filename,
        start=start + 1,
        end=end,
        shown=end - start,
        section=section,
    )

    agent_bin = os.path.join(os.path.dirname(__file__), "..", "target", "release", "pi-agent.exe")
    env = {
        "API_KEY": "sk-6fdefd57386cfe2a-ra242r-af2d3f16",
        "ENDPOINT": "https://ourproxy.sryze.cc/v1/chat/completions",
        "MODEL": model,
        "MAX_TURNS": "10",
        "MAX_TOKENS": "8192",
    }
    payload = json.dumps({"prompt": prompt})
    try:
        proc = subprocess.run(
            [agent_bin],
            input=payload,
            capture_output=True,
            text=True,
            errors="replace",
            env={**os.environ, **env},
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        return False, "TIMEOUT (300s) — proxy unresponsive"

    try:
        result = json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError):
        return False, f"Invalid pi-agent stdout: {proc.stdout[:400]}"

    return bool(result.get("success")), result.get("result", result.get("error", "unknown"))


def main():
    ap = argparse.ArgumentParser(description="Windowed no-lie code audit")
    ap.add_argument("filepath")
    ap.add_argument("--model", default=os.environ.get("MODEL", "kilwa-grok-4.3/kilwa-grok-4.3"))
    ap.add_argument("--window", type=int, default=WINDOW_DEFAULT)
    ap.add_argument("--overlap", type=int, default=OVERLAP_DEFAULT)
    args = ap.parse_args()

    filepath = args.filepath
    content = open(filepath, "rb").read().decode("utf-8", errors="replace")
    filename = os.path.basename(filepath)
    lines = content.splitlines()
    total = len(lines)
    win = max(1, args.window)
    ov = max(0, min(args.overlap, win - 1))

    windows = []
    if total <= win:
        windows.append((0, total))
    else:
        start = 0
        while start < total:
            end = min(start + win, total)
            windows.append((start, end))
            if end >= total:
                break
            start = end - ov  # overlap so boundary code is seen in full

    print(f"=== AUDIT: {filename} ({total} lines, model={args.model}) ===")
    print(f"Windows: {len(windows)} (window={win}, overlap={ov})")
    print("-" * 60)

    severity_counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    all_findings = []
    t0 = time.time()

    for idx, (start, end) in enumerate(windows, 1):
        print(f"\n--- Window {idx}/{len(windows)}: absolute lines {start + 1}-{end} ---")
        w0 = time.time()
        ok, text = run_audit_window(filepath, filename, lines, start, end, args.model)
        w_elapsed = time.time() - w0
        print(text)
        print(f"[window {idx} elapsed: {w_elapsed:.1f}s, success={ok}]")

        if ok and text.strip().upper() != "CLEAR":
            for m in re.finditer(r"\b(HIGH|MEDIUM|LOW)\b", text, re.IGNORECASE):
                sev = m.group(1).upper()
                if sev in severity_counts:
                    severity_counts[sev] += 1
            all_findings.append((idx, text))

    total_elapsed = time.time() - t0
    print("\n" + "=" * 60)
    print(f"=== SEVERITY SUMMARY (auto-count of severity keywords in findings) ===")
    print(f"HIGH: {severity_counts['HIGH']}  MEDIUM: {severity_counts['MEDIUM']}  LOW: {severity_counts['LOW']}")
    print(f"Total elapsed: {total_elapsed:.1f}s across {len(windows)} windows")
    print("NOTE: severity counts are keyword-based; verify each finding against the code.")


if __name__ == "__main__":
    main()
