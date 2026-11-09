#!/usr/bin/env python3
"""Convert a recorded map-making session into session.json + frames.zarr (Zarr v3).

Usage:
    python tools/build_session.py <source-dir> <out-dir> [--allow-email ADDRESS ...]

<source-dir> holds session.source.json, the PNG captures it refers to, and any
message files (contentFile). <out-dir> receives the publishable bundle:

    <out-dir>/session.json
    <out-dir>/frames.zarr/        Zarr v3, uint8, (step, y, x, channel), RGBA, 1200x900
    <out-dir>/thumbs.zarr/        same layout at 600x450, used by the layers view

A build report with per-frame RGBA SHA-256 hashes and byte sizes is written to
<source-dir>/build-report.json. It is used for verification and is not published.

Steps without a capture get frameIndex null. frameIndex is assigned in step order
and is never derived from stepId.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import zarr
from PIL import Image
from zarr.codecs import BytesCodec, GzipCodec

SCHEMA_VERSION = 1
WIDTH, HEIGHT, CHANNELS = 1200, 900, 4
THUMB_W, THUMB_H = 600, 450
GZIP_LEVEL = 6
STATUSES = {"success", "error"}
ROLES = {"user", "assistant", "tool", "note"}

SECRET_PATTERNS = [
    ("API key (sk-)", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("Private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("Bearer token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*")),
]
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def bilingual(value, where: str) -> dict:
    if isinstance(value, str):
        return {"en": value, "ja": value}
    if not isinstance(value, dict) or not value.get("en"):
        fail(f"{where}: expected a string or an object with at least 'en'")
    return {"en": value["en"], "ja": value.get("ja") or value["en"]}


def scan_text(text: str, where: str, allow_emails: set[str], problems: list[str]) -> None:
    for label, pattern in SECRET_PATTERNS:
        if pattern.search(text):
            problems.append(f"{where}: looks like a {label}")
    for m in EMAIL.finditer(text):
        addr = m.group(0)
        if addr.lower() in allow_emails or addr.lower().startswith("noreply@"):
            continue
        problems.append(f"{where}: e-mail address {addr}")


def load_rgba(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        if im.size != (WIDTH, HEIGHT):
            fail(f"{path}: size {im.size[0]}x{im.size[1]}, expected {WIDTH}x{HEIGHT} CSS px at device scale 1")
        rgba = np.asarray(im.convert("RGBA"), dtype=np.uint8)
    assert rgba.shape == (HEIGHT, WIDTH, CHANNELS)
    return np.ascontiguousarray(rgba)


def create_frames_array(path: Path, n: int, height: int, width: int, note: str):
    return zarr.create_array(
        store=str(path),
        shape=(n, height, width, CHANNELS),
        chunks=(1, height, width, CHANNELS),
        dtype="uint8",
        fill_value=0,
        serializer=BytesCodec(),
        compressors=GzipCodec(level=GZIP_LEVEL),
        dimension_names=("step", "y", "x", "channel"),
        attributes={"channels": "RGBA", "note": note},
        zarr_format=3,
        config={"write_empty_chunks": True},
    )


def thumbnail(rgba: np.ndarray) -> np.ndarray:
    im = Image.fromarray(rgba, mode="RGBA").resize((THUMB_W, THUMB_H), Image.Resampling.BOX)
    return np.ascontiguousarray(np.asarray(im, dtype=np.uint8))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--allow-email", action="append", default=[], help="e-mail address that may appear in messages")
    args = ap.parse_args()

    src_dir: Path = args.source
    src = json.loads((src_dir / "session.source.json").read_text(encoding="utf-8"))
    if src.get("schemaVersion") != SCHEMA_VERSION:
        fail(f"schemaVersion must be {SCHEMA_VERSION}")
    kind = src.get("kind")
    if kind not in {"fixture", "production"}:
        fail("kind must be 'fixture' or 'production'")

    allow_emails = {a.lower() for a in args.allow_email}
    problems: list[str] = []
    seen_ids: set[str] = set()
    steps_out = []
    captures: list[tuple[str, Path]] = []

    for i, step in enumerate(src.get("steps") or []):
        sid = step.get("stepId")
        if not sid or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", sid):
            fail(f"steps[{i}]: stepId must be a non-empty identifier")
        if sid in seen_ids:
            fail(f"duplicate stepId {sid}")
        seen_ids.add(sid)
        status = step.get("status")
        if status not in STATUSES:
            fail(f"{sid}: status must be one of {sorted(STATUSES)}")

        messages = []
        for j, msg in enumerate(step.get("messages") or []):
            role = msg.get("role")
            if role not in ROLES:
                fail(f"{sid}.messages[{j}]: role must be one of {sorted(ROLES)}")
            if "contentFile" in msg:
                content = (src_dir / msg["contentFile"]).read_text(encoding="utf-8").rstrip("\n")
            else:
                content = msg.get("content")
            if not isinstance(content, str) or not content.strip():
                fail(f"{sid}.messages[{j}]: empty content")
            scan_text(content, f"{sid}.messages[{j}]", allow_emails, problems)
            out_msg = {"role": role, "content": content}
            for key in ("model", "label"):
                if msg.get(key):
                    out_msg[key] = msg[key]
            messages.append(out_msg)

        frame_index = None
        if step.get("capture"):
            frame_index = len(captures)
            captures.append((sid, src_dir / step["capture"]))

        summary = bilingual(step.get("changeSummary", ""), f"{sid}.changeSummary")
        scan_text(summary["en"] + "\n" + summary["ja"], f"{sid}.changeSummary", allow_emails, problems)
        steps_out.append({
            "stepId": sid,
            "frameIndex": frame_index,
            "timestamp": step.get("timestamp"),
            "status": status,
            "changeSummary": summary,
            "revision": step.get("revision"),
            "messages": messages,
        })

    if not steps_out:
        fail("no steps")
    if problems:
        print("Possible secrets or personal data found. Redact them before publishing:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(1)

    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    zarr_path = out_dir / "frames.zarr"
    thumb_path = out_dir / "thumbs.zarr"
    for p in (zarr_path, thumb_path):
        if p.exists():
            shutil.rmtree(p)

    n = len(captures)
    report_frames = []
    arr = None
    if n:
        arr = create_frames_array(zarr_path, n, HEIGHT, WIDTH, "Screen pixels, not a georeferenced raster.")
        thumbs = create_frames_array(thumb_path, n, THUMB_H, THUMB_W, "Box-downsampled copy of frames.zarr for the layers view.")
        for idx, (sid, path) in enumerate(captures):
            rgba = load_rgba(path)
            arr[idx] = rgba
            th = thumbnail(rgba)
            thumbs[idx] = th
            raw = rgba.tobytes()
            chunk_file = zarr_path / "c" / str(idx) / "0" / "0" / "0"
            report_frames.append({
                "frameIndex": idx,
                "stepId": sid,
                "source": path.relative_to(src_dir).as_posix(),
                "width": WIDTH,
                "height": HEIGHT,
                "rgbaSha256": hashlib.sha256(raw).hexdigest(),
                "rawBytes": len(raw),
                "chunkBytes": chunk_file.stat().st_size,
                "pngBytes": path.stat().st_size,
                "thumbRgbaSha256": hashlib.sha256(th.tobytes()).hexdigest(),
                "thumbChunkBytes": (thumb_path / "c" / str(idx) / "0" / "0" / "0").stat().st_size,
            })

        # Read back with zarr-python and compare hashes before anything is published.
        back = zarr.open_array(str(zarr_path), mode="r")
        assert back.shape == (n, HEIGHT, WIDTH, CHANNELS) and back.dtype == np.uint8
        for fr in report_frames:
            got = hashlib.sha256(np.ascontiguousarray(back[fr["frameIndex"]]).tobytes()).hexdigest()
            if got != fr["rgbaSha256"]:
                fail(f"read-back mismatch at frame {fr['frameIndex']}")
            # Also confirm the chunk is plain gzip that a browser DecompressionStream can read.
            chunk = (zarr_path / "c" / str(fr["frameIndex"]) / "0" / "0" / "0").read_bytes()
            if hashlib.sha256(gzip.decompress(chunk)).hexdigest() != fr["rgbaSha256"]:
                fail(f"gzip chunk mismatch at frame {fr['frameIndex']}")
        tback = zarr.open_array(str(thumb_path), mode="r")
        for fr in report_frames:
            got = hashlib.sha256(np.ascontiguousarray(tback[fr["frameIndex"]]).tobytes()).hexdigest()
            if got != fr["thumbRgbaSha256"]:
                fail(f"thumbnail read-back mismatch at frame {fr['frameIndex']}")

    session = {
        "schemaVersion": SCHEMA_VERSION,
        "id": src.get("id") or out_dir.name,
        "kind": kind,
        "title": bilingual(src.get("title", "Untitled session"), "title"),
        "model": src.get("model"),
        "recording": bilingual(src.get("recording", ""), "recording"),
        "dataSources": src.get("dataSources") or [],
        "viewport": {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 1},
        "frames": {
            "path": "frames.zarr" if n else None,
            "count": n,
            "shape": [n, HEIGHT, WIDTH, CHANNELS],
            "dtype": "uint8",
            "channels": "RGBA",
            "dimensionNames": ["step", "y", "x", "channel"],
            "chunks": [1, HEIGHT, WIDTH, CHANNELS],
            "codecs": ["bytes", f"gzip(level={GZIP_LEVEL})"],
        },
        "thumbnails": {
            "path": "thumbs.zarr" if n else None,
            "count": n,
            "shape": [n, THUMB_H, THUMB_W, CHANNELS],
            "dtype": "uint8",
            "channels": "RGBA",
            "chunks": [1, THUMB_H, THUMB_W, CHANNELS],
            "resampling": "box",
        },
        "steps": steps_out,
    }
    (out_dir / "session.json").write_text(json.dumps(session, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    totals = {
        "frames": n,
        "rawBytes": sum(f["rawBytes"] for f in report_frames),
        "chunkBytes": sum(f["chunkBytes"] for f in report_frames),
        "pngBytes": sum(f["pngBytes"] for f in report_frames),
        "thumbChunkBytes": sum(f["thumbChunkBytes"] for f in report_frames),
    }
    report = {
        "sessionId": session["id"],
        "zarrPython": zarr.__version__,
        "codec": f"bytes -> gzip(level={GZIP_LEVEL})",
        "frames": report_frames,
        "totals": totals,
    }
    (src_dir / "build-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"{len(steps_out)} steps, {n} frames -> {out_dir}")
    for f in report_frames:
        print(f"  frame {f['frameIndex']} ({f['stepId']}): raw {f['rawBytes']:,} B, gzip chunk {f['chunkBytes']:,} B, PNG {f['pngBytes']:,} B")


if __name__ == "__main__":
    main()
