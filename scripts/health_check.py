#!/usr/bin/env python3
"""Daily health check for BCH Tip Bot. Sends an email only when something
looks off — silent on healthy days. Reuses the Gmail SMTP config already
present at /opt/qube_stats.py."""

import sqlite3
import subprocess
import sys
import os
from datetime import datetime, timezone
from email.mime.text import MIMEText
import smtplib

sys.path.insert(0, "/opt")
from qube_stats import EMAIL_CONFIG  # type: ignore

DB_PATH = os.path.expanduser("~/BCH-Tip-Bot/data/tipbot.db")
LOG_PATH = os.path.expanduser("~/.pm2/logs/bch-tip-bot-out.log")
PM2_PROCESS_NAME = "bch-tip-bot"
SUBJECT_PREFIX = "[BCH Tip Bot]"

# Thresholds
MENTION_POLLER_STALE_DAYS = 5
DM_POLLER_STALE_HOURS = 24
STUCK_WITHDRAWAL_MIN_MINUTES = 60
DISK_USAGE_ALERT_PCT = 95
RECENT_ERROR_THRESHOLD = 100


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, capture_output=True, text=True).stdout


def check_pm2() -> str | None:
    out = run(["pm2", "jlist"])
    if PM2_PROCESS_NAME not in out:
        return f"PM2 process '{PM2_PROCESS_NAME}' not found in `pm2 jlist`"
    if '"status":"online"' not in out:
        return f"PM2 process '{PM2_PROCESS_NAME}' is not online"
    return None


def check_poll_state(conn: sqlite3.Connection) -> list[str]:
    issues = []
    rows = conn.execute("SELECT key, value, updated_at FROM poll_state").fetchall()
    state = {k: (v, u) for k, v, u in rows}
    now = datetime.now(timezone.utc)

    if "last_mention_id" in state:
        updated = datetime.fromisoformat(state["last_mention_id"][1] + "+00:00")
        age_days = (now - updated).total_seconds() / 86400
        if age_days > MENTION_POLLER_STALE_DAYS:
            issues.append(
                f"Mention poller stale: last_mention_id updated {age_days:.1f}d ago "
                f"(threshold {MENTION_POLLER_STALE_DAYS}d)"
            )
    else:
        issues.append("Mention poller has no last_mention_id row")

    if "last_dm_event_id" in state:
        updated = datetime.fromisoformat(state["last_dm_event_id"][1] + "+00:00")
        age_hours = (now - updated).total_seconds() / 3600
        if age_hours > DM_POLLER_STALE_HOURS:
            issues.append(
                f"DM poller stale: last_dm_event_id updated {age_hours:.1f}h ago "
                f"(threshold {DM_POLLER_STALE_HOURS}h)"
            )
    else:
        issues.append("DM poller has no last_dm_event_id row")

    return issues


def check_stuck_withdrawals(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        """
        SELECT id, user_id, amount_satoshis, address, created_at
          FROM transactions
         WHERE type = 'withdrawal' AND status = 'pending' AND txid IS NULL
           AND created_at < datetime('now', ?)
         ORDER BY created_at
        """,
        (f"-{STUCK_WITHDRAWAL_MIN_MINUTES} minutes",),
    ).fetchall()
    if not rows:
        return []
    lines = [
        f"  - tx #{r[0]} user={r[1]} amount={r[2]} sat to {r[3]} (created {r[4]} UTC)"
        for r in rows
    ]
    return [
        f"{len(rows)} stuck withdrawal(s) older than {STUCK_WITHDRAWAL_MIN_MINUTES}m:",
        *lines,
    ]


def check_disk() -> str | None:
    out = run(["df", "--output=pcent", "/"]).strip().split("\n")
    if len(out) < 2:
        return "Could not read disk usage"
    pct = int(out[1].strip().rstrip("%"))
    if pct >= DISK_USAGE_ALERT_PCT:
        return f"Disk usage at {pct}% (threshold {DISK_USAGE_ALERT_PCT}%)"
    return None


def check_recent_errors() -> str | None:
    if not os.path.exists(LOG_PATH):
        return None
    # Count level:50 entries in current log file (rotated daily so this is
    # roughly the last 24h of logs).
    out = run(["grep", "-c", '"level":50', LOG_PATH]).strip()
    try:
        count = int(out)
    except ValueError:
        count = 0
    if count >= RECENT_ERROR_THRESHOLD:
        return f"{count} error-level log entries in current log (threshold {RECENT_ERROR_THRESHOLD})"
    return None


def send_email(subject: str, body: str) -> None:
    msg = MIMEText(body)
    msg["Subject"] = f"{SUBJECT_PREFIX} {subject}"
    msg["From"] = EMAIL_CONFIG["sender_email"]
    msg["To"] = EMAIL_CONFIG["recipient_email"]
    with smtplib.SMTP(EMAIL_CONFIG["smtp_server"], EMAIL_CONFIG["smtp_port"]) as srv:
        srv.starttls()
        srv.login(EMAIL_CONFIG["sender_email"], EMAIL_CONFIG["sender_password"])
        srv.send_message(msg)


def main() -> int:
    force = "--force" in sys.argv  # send a digest even when healthy (for testing)

    issues: list[str] = []

    pm2_issue = check_pm2()
    if pm2_issue:
        issues.append(pm2_issue)

    try:
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        issues += check_poll_state(conn)
        issues += check_stuck_withdrawals(conn)
        conn.close()
    except sqlite3.Error as e:
        issues.append(f"DB read failed: {e}")

    disk_issue = check_disk()
    if disk_issue:
        issues.append(disk_issue)

    error_issue = check_recent_errors()
    if error_issue:
        issues.append(error_issue)

    if not issues and not force:
        return 0

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    if issues:
        subject = f"Health check found {len(issues)} issue(s)"
        body = f"Health check at {now}\n\nIssues:\n" + "\n".join(
            f"  - {i}" if not i.startswith("  ") else i for i in issues
        )
    else:
        subject = "Health check OK"
        body = f"Health check at {now}\n\nAll checks passed."

    send_email(subject, body)
    print(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
