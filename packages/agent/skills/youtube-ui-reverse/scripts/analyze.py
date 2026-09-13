#!/usr/bin/env python3
"""Extract UI interaction events from a screen-recording video (or YouTube URL).

Pipeline:
  1. Download the video with yt-dlp (unless --video is given).
  2. Sample frames with ffmpeg at a fixed rate.
  3. Detect onscreen change events with OpenCV: consecutive-frame pixel diffs,
     thresholded and clustered into spatiotemporal blobs.
  4. Write events.json (timeline + bounding boxes), before/after snapshots and
     tight crops per event, plus a human-readable report.md.

The agent (or any vision model) then reads the snapshots to interpret which
option/menu opened at each event and where on the screen it happened.

Usage:
  python3 analyze.py --url https://www.youtube.com/watch?v=... --out ./work
  python3 analyze.py --video ./recording.mp4 --out ./work [--fps 4] [--threshold 12]
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

REQUIRED_BINS = ["ffmpeg", "ffprobe"]


def log(msg: str) -> None:
    print(f"[analyze] {msg}", flush=True)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    log(f"$ {' '.join(cmd)}")
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kwargs)


def require_bins() -> None:
    for bin_name in REQUIRED_BINS:
        if shutil.which(bin_name) is None:
            sys.exit(f"error: `{bin_name}` not found in PATH (install ffmpeg)")
    if shutil.which("yt-dlp") is None:
        log("warning: yt-dlp not found; --video mode only")


def download(url: str, workdir: Path) -> Path:
    out = workdir / "source.mp4"
    if out.exists():
        log(f"reusing existing {out}")
        return out
    run(
        [
            "yt-dlp",
            "-f",
            "bv*[height<=1080]+ba/b[height<=1080]/best",
            "--no-playlist",
            "--newline",
            "-o",
            str(workdir / "source.%(ext)s"),
            url,
        ]
    )
    candidates = list(workdir.glob("source.*"))
    if not candidates:
        sys.exit("error: download produced no file")
    src = candidates[0]
    if src.suffix != ".mp4":
        remuxed = workdir / "source.mp4"
        run(["ffmpeg", "-y", "-i", str(src), "-c", "copy", str(remuxed)])
        src = remuxed
    return src


def probe(video: Path) -> dict:
    out = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate,duration",
            "-of",
            "json",
            str(video),
        ]
    )
    stream = json.loads(out.stdout)["streams"][0]
    num, den = (stream.get("r_frame_rate", "30/1") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": fps,
        "duration": float(stream.get("duration") or 0),
    }


def duration_safe(video: Path) -> float:
    try:
        return probe(video)["duration"]
    except Exception:
        return 60.0


def sample_frames(video: Path, framedir: Path, fps: float, max_frames: int) -> tuple[int, float]:
    """Extract evenly spaced frames. Returns (count, effective rate)."""
    framedir.mkdir(parents=True, exist_ok=True)
    duration = duration_safe(video)
    # Never exceed max_frames: cap the sampling rate when the video is long.
    effective = fps if duration <= 0 else min(fps, max(0.1, max_frames / duration))
    run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video),
            "-vf",
            f"fps={effective:.3f},scale=640:-2",
            "-q:v",
            "3",
            str(framedir / "f_%05d.jpg"),
        ]
    )
    count = len(list(framedir.glob("f_*.jpg")))
    return count, effective


def diff_areas(framedir: Path, threshold: int, min_area: int) -> list[float]:
    """changed[k] = peak contour area of frames[k+1] vs frames[k] (0 when quiet)."""
    import cv2
    import numpy as np

    frames = sorted(framedir.glob("f_*.jpg"))
    if len(frames) < 3:
        sys.exit("error: not enough frames extracted (check --fps/--max-frames)")

    prev = cv2.imread(str(frames[0]), cv2.IMREAD_GRAYSCALE)
    if prev is None:
        sys.exit(f"error: cannot read {frames[0]}")

    changed: list[float] = []
    for path in frames[1:]:
        cur = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if cur is None:
            changed.append(0.0)
            continue
        diff = cv2.absdiff(prev, cur)
        diff = cv2.GaussianBlur(diff, (5, 5), 0)
        _, mask = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)
        mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=1)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        area = max((cv2.contourArea(c) for c in contours), default=0.0)
        changed.append(area if area >= min_area else 0.0)
        prev = cur
    return changed


def cluster(changed: list[float], quiet_gap: int = 2) -> list[tuple[int, int, float]]:
    """Group consecutive changed frames into (start, end, peak) runs.

    A run is broken when `quiet_gap` consecutive unchanged frames appear.
    `start`/`end` are indices into `changed` (frame index k+1 vs k).
    """
    runs: list[tuple[int, int, float]] = []
    run_start: int | None = None
    run_end = 0
    quiet = 0
    run_peak = 0.0
    for i, area in enumerate(changed):
        if area > 0:
            if run_start is None:
                run_start = i
            run_end = i
            run_peak = max(run_peak, area)
            quiet = 0
        elif run_start is not None:
            quiet += 1
            if quiet > quiet_gap:
                runs.append((run_start, run_end, run_peak))
                run_start, run_peak = None, 0.0
    if run_start is not None:
        runs.append((run_start, run_end, run_peak))
    return runs


def snapshots(framedir: Path, snapsdir: Path, runs: list[tuple[int, int, float]], threshold: int, min_area: int) -> list[dict]:
    import cv2
    import numpy as np

    snapsdir.mkdir(parents=True, exist_ok=True)
    frames = sorted(framedir.glob("f_*.jpg"))
    results: list[dict] = []
    for event_no, (start, end, peak) in enumerate(runs, start=1):
        # changed[k] compares frames[k+1] vs frames[k], so the settled
        # before/after states are frames[start] and frames[end + 1].
        before_idx = start
        after_idx = min(end + 1, len(frames) - 1)
        before = cv2.imread(str(frames[before_idx]))
        after = cv2.imread(str(frames[after_idx]))
        if before is None or after is None:
            continue
        diff = cv2.absdiff(cv2.cvtColor(before, cv2.COLOR_BGR2GRAY), cv2.cvtColor(after, cv2.COLOR_BGR2GRAY))
        _, mask = cv2.threshold(diff, threshold, 255, cv2.THRESH_BINARY)
        mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=2)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        xs, ys = [], []
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            if w * h >= min_area:
                xs += [x, x + w]
                ys += [y, y + h]
        if not xs:
            continue
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        pad = int(0.15 * max(x1 - x0, y1 - y0)) + 4
        cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
        cx1 = min(before.shape[1], x1 + pad)
        cy1 = min(before.shape[0], y1 + pad)

        tag = f"{event_no:04d}"
        before_crop = snapsdir / f"event-{tag}-before-crop.jpg"
        after_crop = snapsdir / f"event-{tag}-after-crop.jpg"
        cv2.imwrite(str(snapsdir / f"event-{tag}-before.jpg"), before)
        cv2.imwrite(str(snapsdir / f"event-{tag}-after.jpg"), after)
        cv2.imwrite(str(before_crop), before[cy0:cy1, cx0:cx1])
        cv2.imwrite(str(after_crop), after[cy0:cy1, cx0:cx1])

        w, h = before.shape[1], before.shape[0]
        results.append(
            {
                "id": event_no,
                "start_frame": before_idx + 1,
                "end_frame": after_idx + 1,
                "bbox": {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0},
                "normalized_center": {"x": round((x0 + x1) / 2 / w, 4), "y": round((y0 + y1) / 2 / h, 4)},
                "snapshot": {
                    "before": str(snapsdir / f"event-{tag}-before.jpg"),
                    "after": str(snapsdir / f"event-{tag}-after.jpg"),
                    "before_crop": str(before_crop),
                    "after_crop": str(after_crop),
                },
            }
        )
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="YouTube (or yt-dlp supported) URL to download")
    parser.add_argument("--video", help="local video file instead of downloading")
    parser.add_argument("--out", required=True, help="output directory")
    parser.add_argument("--fps", type=float, default=4.0, help="frame sampling rate (default 4)")
    parser.add_argument("--max-frames", type=int, default=1500, help="cap on sampled frames (default 1500)")
    parser.add_argument("--threshold", type=int, default=12, help="pixel diff threshold (default 12)")
    parser.add_argument("--min-area", type=int, default=400, help="min change area in px (default 400)")
    args = parser.parse_args()

    if not args.url and not args.video:
        sys.exit("error: pass --url or --video")
    require_bins()

    work = Path(args.out)
    work.mkdir(parents=True, exist_ok=True)

    if args.video:
        video = Path(args.video)
        if not video.exists():
            sys.exit(f"error: {video} not found")
    else:
        video = download(args.url, work)

    meta = probe(video)
    log(f"video: {meta['width']}x{meta['height']} @ {meta['fps']:.2f} fps, {meta['duration']:.1f}s")

    framedir = work / "frames"
    count, effective = sample_frames(video, framedir, args.fps, args.max_frames)
    log(f"sampled {count} frames @ {effective:.3f} fps")
    if count < 3:
        sys.exit("error: sample produced too few frames; lower --fps or raise --max-frames")

    changed = diff_areas(framedir, args.threshold, args.min_area)
    runs = cluster(changed)
    events = snapshots(framedir, work / "snaps", runs, args.threshold, args.min_area)
    for e in events:
        e["t_start"] = round((e["start_frame"] - 1) / effective, 3)
        e["t_end"] = round((e["end_frame"] - 1) / effective, 3)

    report = {
        "meta": {**meta, "url": args.url, "video": str(video), "frames_sampled": count, "sample_fps": effective},
        "events": events,
    }
    (work / "events.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    lines = [
        "# UI Interaction Events",
        "",
        f"- video: `{video}` ({meta['width']}x{meta['height']}, {meta['duration']:.1f}s)",
        f"- frames sampled: {count} @ {effective:.2f} fps",
        f"- detected events: {len(events)}",
        "",
        "| # | t_start | t_end | center (norm) | peak area | before crop | after crop |",
        "|---|---|---|---|---|---|---|",
    ]
    for e in events:
        lines.append(
            f"| {e['id']} | {e['t_start']:.2f}s | {e['t_end']:.2f}s | "
            f"({e['normalized_center']['x']:.3f}, {e['normalized_center']['y']:.3f}) | "
            f"{e['bbox']['w'] * e['bbox']['h']} px | `{e['snapshot']['before_crop']}` | `{e['snapshot']['after_crop']}` |"
        )
    (work / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    log(f"wrote {work / 'events.json'} ({len(events)} events) and {work / 'report.md'}")


if __name__ == "__main__":
    main()
