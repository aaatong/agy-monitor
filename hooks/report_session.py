#!/usr/bin/env python3
"""Antigravity lifecycle hook that records the active session for AGY Monitor."""

import json
import os
import sys
import time
from pathlib import Path

MAX_RECENT = 20
STATE_FILENAME = "active-session.json"


def resolve_state_dir() -> Path:
    plugin_data = (os.environ.get("PLUGIN_DATA") or "").strip()
    if plugin_data:
        return Path(plugin_data).expanduser()
    return Path.home() / ".gemini" / "config" / "plugin-data" / "agy-monitor"


def normalize_workspace_paths(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if isinstance(item, (str, Path)) and str(item)]
    return []


def load_existing_recent(state_file: Path) -> list[dict]:
    if not state_file.is_file():
        return []
    try:
        raw = json.loads(state_file.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, dict):
        return []
    recent = raw.get("recent")
    if not isinstance(recent, list):
        return []
    return [entry for entry in recent if isinstance(entry, dict) and entry.get("conversationId")]


def build_record(payload: dict, previous: dict | None, now_ms: int) -> dict:
    prev = previous or {}

    conversation_id = str(payload.get("conversationId") or "").strip()
    transcript_path = str(payload.get("transcriptPath") or "").strip() or str(
        prev.get("transcriptPath") or ""
    )
    model_name = str(payload.get("modelName") or "").strip() or str(
        prev.get("modelName") or ""
    )
    workspace_paths = normalize_workspace_paths(payload.get("workspacePaths"))
    if not workspace_paths:
        workspace_paths = normalize_workspace_paths(prev.get("workspacePaths"))
    hook_event_name = str(payload.get("hookEventName") or "").strip()
    cwd = str(payload.get("cwd") or "").strip() or str(prev.get("cwd") or "")

    return {
        "conversationId": conversation_id,
        "transcriptPath": transcript_path,
        "modelName": model_name,
        "workspacePaths": workspace_paths,
        "hookEventName": hook_event_name,
        "cwd": cwd,
        "updatedAt": now_ms,
    }


def atomic_write_json(target: Path, data: dict) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_name = f".{target.name}.{os.getpid()}.{time.time_ns()}.tmp"
    tmp_path = target.parent / tmp_name
    try:
        serialized = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        with tmp_path.open("w", encoding="utf-8") as fh:
            fh.write(serialized)
            fh.flush()
        os.replace(tmp_path, target)
    except Exception:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass
        raise


def update_active_session() -> None:
    raw_stdin = sys.stdin.read()
    if not raw_stdin or not raw_stdin.strip():
        return

    payload = json.loads(raw_stdin)
    if not isinstance(payload, dict):
        return

    conversation_id = str(payload.get("conversationId") or "").strip()
    if not conversation_id:
        return

    state_dir = resolve_state_dir()
    state_file = state_dir / STATE_FILENAME

    existing_recent = load_existing_recent(state_file)
    previous = next(
        (entry for entry in existing_recent if entry.get("conversationId") == conversation_id),
        None,
    )

    now_ms = int(time.time() * 1000)
    record = build_record(payload, previous, now_ms)

    deduped = [entry for entry in existing_recent if entry.get("conversationId") != conversation_id]
    deduped.append(record)
    deduped.sort(key=lambda entry: int(entry.get("updatedAt") or 0), reverse=True)
    recent = deduped[:MAX_RECENT]

    state = {
        "active": record,
        "recent": recent,
    }
    atomic_write_json(state_file, state)


def main() -> None:
    try:
        update_active_session()
    except Exception:
        pass
    finally:
        try:
            sys.stdout.write("{}\n")
            sys.stdout.flush()
        except Exception:
            pass


if __name__ == "__main__":
    main()
