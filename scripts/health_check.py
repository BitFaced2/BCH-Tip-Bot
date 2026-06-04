#!/usr/bin/env python3
"""Daily health check for BCH Tip Bot — runs on the local PC, SSHes into
qube.cash to gather signals, emails a digest via Gmail SMTP (mirrors the
qube_stats.py pattern, which works around DO's outbound-SMTP block).

Always sends an email: "Daily Health Check OK" when everything passes,
or a flagged issues list when something looks off.

Schedule alongside qube_stats.py in Windows Task Scheduler.

Reads QUBES_STATS_EMAIL_PASSWORD from env (the same secret qube_stats.py
already uses)."""

import json
import os
import re
import smtplib
import subprocess
import sys
from datetime import datetime, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

SERVER = "bit_faced@167.71.100.232"
SSH_KEY = os.path.expanduser("~/.ssh/qube_stats_key")
DB_PATH = "~/BCH-Tip-Bot/data/tipbot.db"
LOG_PATH = "~/.pm2/logs/bch-tip-bot-out.log"
PM2_PROCESS_NAME = "bch-tip-bot"

EMAIL_CONFIG = {
    "smtp_server": "smtp.gmail.com",
    "smtp_port": 587,
    "sender_email": os.environ.get("QUBES_STATS_EMAIL", "elmore253@gmail.com"),
    "sender_password": os.environ.get("QUBES_STATS_EMAIL_PASSWORD", ""),
    "recipient_email": "bit_faced@pm.me",
}

# Thresholds — alert when any check exceeds these. Mention threshold is
# above X's 7-day since_id window so a quiet stretch where the bot's own
# reactive handler clears the row doesn't trigger noise; if mentions are
# legitimately silent for >8d, that's worth knowing.
MENTION_POLLER_STALE_DAYS = 8
DM_POLLER_STALE_HOURS = 48
STUCK_WITHDRAWAL_MIN_MINUTES = 60
DISK_USAGE_ALERT_PCT = 95
RECENT_ERROR_THRESHOLD = 100


def ssh(command: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes", SERVER, command],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def check_pm2() -> str | None:
    result = ssh("pm2 jlist 2>/dev/null")
    if result.returncode != 0 or not result.stdout.strip():
        return "Could not query pm2 over SSH"
    try:
        procs = json.loads(result.stdout)
    except json.JSONDecodeError:
        return "pm2 jlist did not return JSON"
    bot = next((p for p in procs if p.get("name") == PM2_PROCESS_NAME), None)
    if not bot:
        return f"PM2 process '{PM2_PROCESS_NAME}' not found"
    status = bot.get("pm2_env", {}).get("status")
    if status != "online":
        return f"PM2 process '{PM2_PROCESS_NAME}' status: {status}"
    return None


def check_poll_state() -> list[str]:
    result = ssh(
        f"sqlite3 -separator '|' {DB_PATH} \"SELECT key, updated_at FROM poll_state;\""
    )
    if result.returncode != 0:
        return [f"Could not read poll_state: {result.stderr.strip()}"]

    issues: list[str] = []
    now = datetime.now(timezone.utc)
    state: dict[str, datetime] = {}
    for line in result.stdout.strip().split("\n"):
        if not line or "|" not in line:
            continue
        key, ts = line.split("|", 1)
        state[key] = datetime.fromisoformat(ts + "+00:00")

    # Missing rows are a valid state (just-cleared by reactive handler, or
    # first run), so only alert on rows that exist and are too old.
    if "last_mention_id" in state:
        age_days = (now - state["last_mention_id"]).total_seconds() / 86400
        if age_days > MENTION_POLLER_STALE_DAYS:
            issues.append(
                f"Mention poller stale: last_mention_id updated {age_days:.1f}d ago "
                f"(threshold {MENTION_POLLER_STALE_DAYS}d)"
            )

    if "last_dm_event_id" in state:
        age_hours = (now - state["last_dm_event_id"]).total_seconds() / 3600
        if age_hours > DM_POLLER_STALE_HOURS:
            issues.append(
                f"DM poller stale: last_dm_event_id updated {age_hours:.1f}h ago "
                f"(threshold {DM_POLLER_STALE_HOURS}h)"
            )

    return issues


def check_stuck_withdrawals() -> list[str]:
    query = (
        "SELECT id, user_id, amount_satoshis, address, created_at "
        "FROM transactions "
        "WHERE type='withdrawal' AND status='pending' AND txid IS NULL "
        f"AND created_at < datetime('now', '-{STUCK_WITHDRAWAL_MIN_MINUTES} minutes') "
        "ORDER BY created_at;"
    )
    result = ssh(f"sqlite3 -separator '|' {DB_PATH} \"{query}\"")
    if result.returncode != 0:
        return [f"Could not query withdrawals: {result.stderr.strip()}"]

    lines = [ln for ln in result.stdout.strip().split("\n") if ln]
    if not lines:
        return []
    formatted = [
        f"  - tx #{p[0]} user={p[1]} amount={p[2]} sat to {p[3]} (created {p[4]} UTC)"
        for p in (ln.split("|") for ln in lines)
        if len(p) >= 5
    ]
    return [
        f"{len(formatted)} stuck withdrawal(s) older than {STUCK_WITHDRAWAL_MIN_MINUTES}m:",
        *formatted,
    ]


def check_disk() -> str | None:
    result = ssh("df --output=pcent / | tail -n 1")
    if result.returncode != 0:
        return None
    match = re.search(r"(\d+)%", result.stdout)
    if not match:
        return None
    pct = int(match.group(1))
    if pct >= DISK_USAGE_ALERT_PCT:
        return f"Disk usage at {pct}% (threshold {DISK_USAGE_ALERT_PCT}%)"
    return None


def check_recent_errors() -> str | None:
    # pm2-logrotate rotates daily, so the current log is roughly last 24h.
    result = ssh(f'grep -c \'"level":50\' {LOG_PATH} 2>/dev/null || echo 0')
    if result.returncode != 0:
        return None
    try:
        count = int(result.stdout.strip())
    except ValueError:
        return None
    if count >= RECENT_ERROR_THRESHOLD:
        return (
            f"{count} error-level log entries in current log "
            f"(threshold {RECENT_ERROR_THRESHOLD})"
        )
    return None


def send_email(subject: str, body: str) -> bool:
    if not EMAIL_CONFIG["sender_password"]:
        print("QUBES_STATS_EMAIL_PASSWORD not set; cannot send email.")
        return False

    msg = MIMEMultipart()
    msg["From"] = EMAIL_CONFIG["sender_email"]
    msg["To"] = EMAIL_CONFIG["recipient_email"]
    msg["Subject"] = subject
    html = (
        "<html><body><pre style=\"font-family:'Courier New',monospace;font-size:14px;\">"
        f"{body}"
        "</pre></body></html>"
    )
    msg.attach(MIMEText(html, "html"))

    try:
        # Without an explicit timeout smtplib will wait forever on a hung
        # socket — that's how yesterday's run produced no email at all.
        with smtplib.SMTP(
            EMAIL_CONFIG["smtp_server"], EMAIL_CONFIG["smtp_port"], timeout=30
        ) as srv:
            srv.starttls()
            srv.login(EMAIL_CONFIG["sender_email"], EMAIL_CONFIG["sender_password"])
            srv.send_message(msg)
        return True
    except Exception as e:
        print(f"Error sending email: {e}")
        return False


def main() -> int:
    issues: list[str] = []

    try:
        pm2_issue = check_pm2()
        if pm2_issue:
            issues.append(pm2_issue)
        issues += check_poll_state()
        issues += check_stuck_withdrawals()
        disk_issue = check_disk()
        if disk_issue:
            issues.append(disk_issue)
        err_issue = check_recent_errors()
        if err_issue:
            issues.append(err_issue)
    except subprocess.TimeoutExpired:
        issues.append("SSH timeout while collecting health signals")
    except Exception as e:
        issues.append(f"Health check error: {e}")

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    today = datetime.now().strftime("%Y-%m-%d")
    if issues:
        subject = f"[BCH Tip Bot] Health check found {len(issues)} issue(s) - {today}"
        body_lines = [f"Health check at {now}", "", "Issues:"]
        for i in issues:
            body_lines.append(i if i.startswith("  ") else f"  - {i}")
    else:
        subject = f"[BCH Tip Bot] Daily Health Check OK - {today}"
        body_lines = [f"Health check at {now}", "", "All checks passed."]

    body = "\n".join(body_lines)
    print(body)
    if send_email(subject, body):
        print(f"Report sent to {EMAIL_CONFIG['recipient_email']}")
        return 0
    print("Failed to send email")
    return 1


if __name__ == "__main__":
    sys.exit(main())
