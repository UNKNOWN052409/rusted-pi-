---
name: youtube-ui-reverse
description: Reverse-engineer an interactive UI from a YouTube screen-recording video. Downloads the video, samples frames, detects click/menu/dialog change events with OpenCV, interprets each event with vision (which option opened, where), and generates a complete interactive UI implementation. Use when the user shares a YouTube URL or screen recording and asks to recreate/replicate the UI in code, understand a UI flow, or generate interactive UI code from a video.
---

# YouTube / Video UI Reverse Engineering

Recreate an interactive UI from a screen recording. The pipeline is: download,
sample frames, detect onscreen changes (the "clicks"), understand each change
with vision, then generate real interactive code.

## Prerequisites

- `yt-dlp` (download), `ffmpeg`/`ffprobe` (frame sampling), Python 3 with
  `opencv-python` (`cv2`) and `numpy`. All optional at runtime — the helper
  reports exactly which binary is missing and the task must stop cleanly, not
  guess.
- The analyzer script lives in this skill directory:
  `scripts/analyze.py` (resolve relative to the skill dir, as usual).

## Steps

1. **Download / extract the video.**
   - With a URL: run the analyzer with `--url`.
   - With a local recording: run it with `--video`.
   - Always pass `--out <workdir>` where `<workdir>` is a fresh directory
     (e.g. `youtube-ui-reverse-work/`). The analyzer downloads to
     `<workdir>/source.mp4`, frames to `<workdir>/frames/`, snapshots to
     `<workdir>/snaps/`, and writes `events.json` + `report.md`.

   ```bash
   python3 "skills/youtube-ui-reverse/scripts/analyze.py" \
     --url "https://www.youtube.com/watch?v=..." --out youtube-ui-reverse-work --fps 4
   ```

2. **Detect interaction events.** The analyzer compares consecutive frames;
   any frame-pair region that changes beyond `--threshold` (default 12) is a
   change area. Consecutive changed frames are clustered into events. Each
   event gets:
   - a bounding box in original pixel coordinates + normalized center,
   - a before/after full-frame snapshot (`event-N-before.jpg` /
     `event-N-after.jpg`),
   - a tight before/after crop focused on the changed region
     (`event-N-before-crop.jpg` / `event-N-after-crop.jpg`),
   - timestamps (`t_start`, `t_end`).

   Resolve the script path relative to the skill dir; do not copy the script
   into the user's repo.

3. **Interpret each event with vision.** For every event:
   - Read the before/after crop images (the `read` tool sends images as
     attachments — verify the current model supports images first; if it does
     not, stop and say the model cannot analyze images rather than guessing).
   - Determine: what did the user click (cursor/pointer position, highlighted
     control), what opened (menu, dropdown, dialog, page navigation, tooltip,
     modal), where on screen (normalized center, and which region of the
     layout — header/sidebar/content), and what changed in the UI state.
   - Read `events.json` for the exact bounding boxes/centers so locations are
     precise rather than eyeballed. Treat the crops as evidence; describe
     states as observed, not as assumed.

4. **Build the interaction model.** From the interpreted events, produce a
   state machine in prose + pseudo-code: initial state, each event's trigger
   (click target), resulting state (open menu / dialog / view), and any
   de-close / navigate transitions shown later in the video. Include the
   on-screen positions (normalized coordinates) for every interactive element.

5. **Generate the interactive UI code.** Produce complete, runnable code that
   reproduces the UI and its interactions (HTML/CSS/JS, React, or the
   framework the user requested; default to plain HTML/CSS/JS so it opens
   without a build step):
   - Match layout and visual style (colors, radii, spacing) from the frames.
   - Every interaction from the model must work: clicking the control opens the
     same menu/dialog with the same options; clicking outside/again closes it.
   - Wire each option to its observed behavior (navigate, toggle, or close) —
     if a behavior was not shown in the video, implement the plausible default
     and note it as an assumption.
   - Put the result in a single self-contained file (or a small folder) next to
     the workdir output, and name it clearly (e.g.
     `youtube-ui-reverse-work/ui/index.html`).

6. **Verify behavior, not just compilation.** Open the generated page (or run
   its test) and exercise every interaction: each click must produce the same
   state change as the video. Report every event as matched or mismatched.

## Output format

Finish with a report:

```markdown
## UI Reverse Engineering Report
- video: <url/path> (<duration>, <resolution>)
- events detected: N

| event | time | what was clicked | what opened | screen location | status |
|---|---|---|---|---|---|
| 1 | 2.5s-3.25s | Settings icon (top-right) | Settings menu | right side, header | implemented |
| ... | ... | ... | ... | ... | ... |

## Generated code
- <file path(s)>
- interactions implemented: ...
- assumptions: ...
```

Every claim about what happened in the video must cite the snapshot it came
from (`snaps/event-N-*.jpg`). Never invent UI states that are not visible in
some frame; mark unseen behavior as an assumption.
