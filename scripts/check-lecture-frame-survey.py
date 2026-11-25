"""Verify local frame artifacts against the saved video; does not review content."""
import argparse
from fractions import Fraction
from hashlib import sha256
import json
from pathlib import Path
import subprocess

from PIL import Image


def digest(path):
    value = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def within(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Artifact outside source root or missing: " + relative)
    return path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root", type=Path)
    parser.add_argument("--manifest", type=Path, default=Path(__file__).resolve().parents[1] / "docs/lecture-frame-window-survey.json")
    args = parser.parse_args()
    root = args.source_root.resolve()
    record = json.loads(args.manifest.read_text())
    require(record["schema"] == "koyuki.lecture-frame-window-survey.v1", "Unknown schema")
    require(record["videoId"] == "w0oLNoGsGLc", "Unexpected video")
    require([(window["id"], window["startSeconds"], window["endSecondsExclusive"]) for window in record["windows"]] == [("w0o-17", 1750, 1761), ("w0o-23", 2404, 2457)], "Unexpected window set")
    require(record["allFramesReviewed"] is False and record["audioDirectlyReviewed"] is False, "A window survey cannot certify full-video review")
    source = within(root, record["source"]["file"])
    require(digest(source) == record["source"]["sha256"], "Source hash mismatch")
    mask = record["excludedRectangle"]
    require(mask == [1088, 0, 192, 108], "Unexpected excluded rectangle")
    require(len(mask) == 4 and all(type(item) is int and item >= 0 for item in mask), "Invalid mask")
    x, y, width, height = mask
    require(width > 0 and height > 0 and x + width <= 1280 and y + height <= 720, "Mask outside source canvas")
    filter_arg = f"drawbox=x={x}:y={y}:w={width}:h={height}:color=black:t=fill"
    verified = []
    for window in record["windows"]:
        start, end, fps = window["startSeconds"], window["endSecondsExclusive"], window["fps"]
        require(type(start) is int and type(end) is int and end > start and fps == 25, "Unexpected window")
        count = (end - start) * fps
        require(window["frameCount"] == count, "Window frame count mismatch")
        frames = [within(root, f"{window['directory']}/frame-{index + 1:04d}.png") for index in range(count)]
        require(len(list(frames[0].parent.glob("frame-*.png"))) == count, "Unexpected frame files")
        cursor = 0
        for sheet in window["contactSheets"]:
            require(sheet["firstFrame"] == cursor and cursor <= sheet["lastFrame"] < count, "Contact sheet coverage gap or overlap")
            require(digest(within(root, sheet["file"])) == sheet["sha256"], "Contact sheet hash mismatch")
            require(sheet["thumbnailReviewed"] is True, "Missing recorded thumbnail review")
            cursor = sheet["lastFrame"] + 1
        require(cursor == count, "Incomplete contact sheets")
        for frame in window["representatives"]:
            require(0 <= frame["index"] < count, "Representative outside window")
            require(digest(frames[frame["index"]]) == frame["sha256"], "Representative hash mismatch")
            require(within(root, frame["file"]) == frames[frame["index"]] and frame["originalResolutionRead"] is True, "Representative review mismatch")
            require(Fraction(str(frame["timeSeconds"])) == Fraction(start) + Fraction(frame["index"], fps), "Representative timestamp mismatch")
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-read_intervals", f"{start}%{end + 1}", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", str(source)], check=True, capture_output=True, text=True)
        times = [Fraction(frame["best_effort_timestamp_time"]) for frame in json.loads(probe.stdout)["frames"]]
        times = [time for time in times if start <= time < end]
        require(times == [Fraction(start) + Fraction(index, fps) for index in range(count)], "Source timestamp coverage mismatch")
        decoded = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-t", str(end - start), "-i", str(source), "-map", "0:v:0", "-an", "-vf", filter_arg, "-pix_fmt", "rgb24", "-fps_mode", "passthrough", "-c:v", "rawvideo", "-f", "framehash", "-hash", "sha256", "-"], check=True, capture_output=True, text=True)
        require("#tb 0: 1/25" in decoded.stdout, "Unexpected decoded time base")
        rows = [line.split(",") for line in decoded.stdout.splitlines() if line and not line.startswith("#")]
        require(len(rows) == count, "Decoded frame count mismatch")
        for index, (row, frame) in enumerate(zip(rows, frames)):
            require(len(row) == 6 and int(row[0]) == 0 and int(row[2]) == index and int(row[3]) == 1, "Decoded frame order mismatch")
            with Image.open(frame) as image:
                require(image.size == (1280, 720), "Unexpected artifact size")
                pixels = image.convert("RGB").tobytes()
            require(int(row[4]) == len(pixels) and sha256(pixels).hexdigest() == row[5].strip(), f"Source pixels differ at {window['id']}#{index}")
        verified.append({"id": window["id"], "sourceFramesVerified": count, "contactSheets": len(window["contactSheets"]), "representatives": len(window["representatives"])})
    print(json.dumps({"verified": verified, "scope": "Source identity, timestamps, pixel equality and artifact coverage only. Reading, interpretation and audio review are NOT automatically verified."}))


if __name__ == "__main__":
    main()
