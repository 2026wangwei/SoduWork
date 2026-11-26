"""Reconcile indeterminate direct-dispatch acknowledgements without duplicate work.

The dispatch RPC is an external side effect.  A timeout only means the Hub did not
receive the reply; it does not prove that the Runner did not start the Agent.  This
module turns that ambiguity into an operational state machine:

* a durable Runner run is authoritative success;
* an explicit negative from the same Runner process is authoritative non-start;
* offline, restarted or legacy Runners remain uncertain and are raised for attention.

No retry is issued here.  Retrying is safe only after a same-process negative has
released the task back to todo, or after a human has independently established that
the external side effect did not happen.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .. import models
from .task_access import publish_task
from ..db import SessionLocal
from . import (ai_exec, ai_remote, execution_sessions, notify, runner_hub,
               task_events, task_status)


log = logging.getLogger("uvicorn.error")


def _setting(name: str, default: int, minimum: int) -> int:
    try:
        return max(minimum, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


PROBE_AFTER_SECONDS = _setting("DISPATCH_RECONCILE_PROBE_SECONDS", 15, 5)
ATTENTION_AFTER_SECONDS = _setting("DISPATCH_RECONCILE_ATTENTION_SECONDS", 300, 60)
SWEEP_SECONDS = _setting("DISPATCH_RECONCILE_INTERVAL_SECONDS", 20, 5)
BATCH_SIZE = _setting("DISPATCH_RECONCILE_BATCH_SIZE", 50, 1)


@dataclass(frozen=True)
class Candidate:
    task_id: str
    attempt_id: str
    expected_ref: str
    runner_id: str
    runner_boot_id: str
    host: str
    at: datetime
    detail: dict
    recorded_nonstart: bool = False


def _utc(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _iso(value: datetime) -> str:
    return _utc(value).isoformat().replace("+00:00", "Z")


def _first_uncertain(detail: dict, fallback: datetime) -> datetime:
    value = str(detail.get("firstUncertainAt") or "").strip()
    if value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return _utc(parsed)
        except ValueError:
            pass
    return _utc(fallback)


async def candidates(session: AsyncSession, *, now: datetime | None = None,
                     limit: int = BATCH_SIZE) -> list[Candidate]:
    """Return only the latest dispatch-state event for each active task."""
    now = _utc(now)
    event = aliased(models.TaskEvent)
    newer = aliased(models.TaskEvent)
    newer_state = exists(select(newer.id).where(
        newer.task_id == event.task_id,
        newer.kind.in_(ai_exec.KINDS_DISPATCH_STATE),
        or_(newer.at > event.at,
            and_(newer.at == event.at, newer.id > event.id)),
    ))
    # Older Hubs returned the shell to todo after recording a proven non-start.
    # Reuse that durable result once, unless somebody subsequently moved the shell.
    legacy_batch = and_(
        event.kind == ai_exec.EV_DISPATCH_FAILED, models.Task.status == "todo", models.Task.archived_at.is_(None),
        event.detail["attemptId"].as_string() == event.task_id,
        event.detail["confirmedNotStarted"].as_boolean().is_(True),
        event.detail["batchReleased"].as_boolean().is_not(True),
        exists(select(models.Milestone.id).where(models.Milestone.task_id == event.task_id,
            models.Milestone.src_task_id != "")),
        ~exists(select(newer.id).where(newer.task_id == event.task_id,
            newer.kind == "task.execution_started", newer.at >= event.at)),
    )
    rows = list((await session.execute(
        select(event).join(models.Task, models.Task.id == event.task_id).where(
            or_(legacy_batch, event.kind == ai_exec.EV_DISPATCH_UNCERTAIN, and_(
                event.kind == ai_exec.EV_DISPATCH_STARTED,
                event.detail["recoverReceipt"].as_boolean().is_(True),
                event.at <= now - timedelta(minutes=10))),
            event.at <= now - timedelta(seconds=PROBE_AFTER_SECONDS),
            models.Task.status.in_(("todo", "doing")),
            ~newer_state,
        ).order_by(event.at.desc(), event.id.desc()).limit(max(1, int(limit)))
    )).scalars().all())
    out: list[Candidate] = []
    for row in rows:
        detail = dict(row.detail or {})
        out.append(Candidate(
            task_id=str(row.task_id or ""),
            attempt_id=str(detail.get("attemptId") or ""),
            expected_ref=str(detail.get("expectedRef") or ""),
            runner_id=str(detail.get("runnerId") or ""),
            runner_boot_id=str(detail.get("runnerBootId") or ""),
            host=str(detail.get("host") or ""),
            at=_utc(row.at),
            detail=detail, recorded_nonstart=row.kind == ai_exec.EV_DISPATCH_FAILED,
        ))
    return out


async def probe(candidate: Candidate) -> dict:
    """Ask the exact Runner for read-only evidence about one deterministic ref."""
    if candidate.recorded_nonstart:
        return {"state": "not-started", "observedBootId": candidate.detail.get("observedBootId")}
    if not candidate.runner_id or not candidate.expected_ref:
        return {"state": "ambiguous", "reason": "missing-route", "runnerOnline": False}
    runner = runner_hub.get(candidate.runner_id)
    if runner is None or not runner.alive():
        return {"state": "ambiguous", "reason": "offline", "runnerOnline": False}
    current_boot = str(getattr(runner, "boot_id", "") or "")
    try:
        reply = await runner.call(
            "job.has", {"ref": candidate.expected_ref,
                        "admissionKey": "dispatch:" + candidate.expected_ref}, timeout=15)
    except Exception as error:  # noqa: BLE001 - a probe must never stop the sweep
        return {"state": "ambiguous", "reason": "probe-error",
                "runnerOnline": True, "error": type(error).__name__,
                "observedBootId": current_boot}
    if not reply.get("ok"):
        return {"state": "ambiguous", "reason": "probe-failed",
                "runnerOnline": True, "error": str(reply.get("error") or "")[:240],
                "observedBootId": current_boot}
    data = dict(reply.get("data") or {})
    observed_boot = str(data.get("bootId") or current_boot)
    persisted = bool(data.get("persisted"))
    inflight = bool(data.get("inflight"))
    has_run = bool(data.get("has"))
    # Legacy Runners only return {has}.  A positive answer remains authoritative.
    if persisted or (has_run and not inflight):
        return {"state": "confirmed", "runnerOnline": True,
                "observedBootId": observed_boot, "persisted": persisted}
    if inflight:
        return {"state": "pending", "reason": "inflight", "runnerOnline": True,
                "observedBootId": observed_boot}
    if (candidate.runner_boot_id and observed_boot
            and candidate.runner_boot_id == observed_boot):
        return {"state": "not-started", "runnerOnline": True,
                "admissionDurable": ("admit1" in getattr(runner, "caps", [])
                    and data.get("admissionDurable") is True
                    and data.get("admissionKey") == "dispatch:" + candidate.expected_ref),
                "observedBootId": observed_boot}
    return {"state": "ambiguous", "reason": "runner-restarted",
            "runnerOnline": True, "observedBootId": observed_boot}


async def _latest_state(session: AsyncSession, task_id: str):
    return (await session.execute(select(models.TaskEvent).where(
        models.TaskEvent.task_id == task_id,
        models.TaskEvent.kind.in_(ai_exec.KINDS_DISPATCH_STATE),
    ).order_by(models.TaskEvent.at.desc(), models.TaskEvent.id.desc()).limit(1)
    )).scalar_one_or_none()


def _same_attempt(event, candidate: Candidate) -> bool:
    if event is None:
        return False
    detail = dict(event.detail or {})
    if event.kind != ai_exec.EV_DISPATCH_UNCERTAIN and not (
            event.kind == ai_exec.EV_DISPATCH_STARTED and detail.get("recoverReceipt")):
        return False
    return (str(detail.get("attemptId") or "") == candidate.attempt_id
            and str(detail.get("expectedRef") or "") == candidate.expected_ref)


def _runner_cli(detail: dict) -> str:
    requested = str(detail.get("requestedId") or "")
    if requested.startswith(ai_exec.REMOTE_PREFIX) and ":" in requested:
        return requested.rsplit(":", 1)[-1]
    return str(detail.get("assigneeCli") or "")


async def apply_probe(session: AsyncSession, candidate: Candidate, result: dict,
                      *, now: datetime | None = None) -> tuple[str, models.Task | None]:
    """Apply one probe under the task row lock; safe across multiple Hub instances."""
    now = _utc(now)
    task = (await session.execute(select(models.Task).where(
        models.Task.id == candidate.task_id).with_for_update())).scalar_one_or_none()
    if task is None or task.status not in {"todo", "doing"}:
        return "stale", task
    latest = await _latest_state(session, candidate.task_id)
    legacy = (latest is not None and latest.kind == ai_exec.EV_DISPATCH_FAILED
              and candidate.recorded_nonstart and latest.detail.get("confirmedNotStarted")
              and latest.detail == candidate.detail
              and not latest.detail.get("batchReleased") and task.status == "todo" and not task.archived_at
              and task.id == candidate.attempt_id)
    if legacy:
        changed = await session.scalar(select(models.TaskEvent.id).where(
            models.TaskEvent.task_id == task.id, models.TaskEvent.kind == "task.execution_started",
            models.TaskEvent.at >= latest.at).limit(1))
        if changed:
            return "stale", task
    elif not _same_attempt(latest, candidate):
        return "stale", task
    detail = dict(latest.detail or {})
    observed_boot = str(result.get("observedBootId") or "")
    state = str(result.get("state") or "ambiguous")

    if state == "confirmed":
        cli = _runner_cli(detail)
        healed = {
            **detail,
            "ref": candidate.expected_ref,
            "issueId": candidate.expected_ref,
            "provider": "runner",
            "runnerId": candidate.runner_id,
            "runnerBootId": observed_boot or candidate.runner_boot_id,
            "host": candidate.host,
            "assigneeId": detail.get("assigneeId") or detail.get("requestedId") or "",
            "assigneeCli": cli,
            "healedFrom": "runner-existence-probe",
            "summary": "执行机已确认收到需求，执行状态已自动接回",
            "retryable": False,
            "uncertain": False,
        }
        task_events.record(
            session, task.id, ai_exec.EV_DISPATCHED, healed, actor="SoduWork")
        await execution_sessions.record_dispatch(session, task, {
            "issueId": candidate.expected_ref,
            "provider": "runner",
            "runnerId": candidate.runner_id,
            "host": candidate.host,
            "assigneeId": healed["assigneeId"],
            "assigneeCli": cli,
            "agentCli": cli,
            "model": detail.get("model") or "",
        })
        if task.status == "todo":
            await task_status.mark(session, task, "doing", why="Runner 存在性探针接回")
        ai_remote.remember(candidate.expected_ref, candidate.runner_id)
        return "confirmed", task

    if state == "not-started":
        from . import batch_dispatch
        is_batch = await batch_dispatch.release_unstarted(session, task, candidate.attempt_id)
        released = await task_status.mark(
            session, task, "cancel" if is_batch else "todo", why="Runner 明确确认未启动")
        summary = ("执行机已确认本次需求没有启动，需求已安全退回待办，可以重新安排执行"
                   if released else
                   "执行机已确认本次需求没有启动，但需求状态仍由工作流接管")
        if is_batch and released:
            summary = "执行机已确认本批次未启动，仍归属本批次的源任务已释放，可以重新派发"
        failed = {
            **detail,
            **({"batchReleased": True} if is_batch or legacy else {}),
            "phase": "confirmation",
            "phaseName": "确认执行机回执",
            "error": "执行机已明确确认本次需求没有启动",
            "summary": summary,
            "retryable": bool(released),
            "uncertain": False,
            "confirmedNotStarted": True,
            "runnerOnline": True,
            "observedBootId": observed_boot,
        }
        task_events.record(
            session, task.id, ai_exec.EV_DISPATCH_FAILED, failed, actor="SoduWork")
        return "released" if released else "attention", task

    first_at = _first_uncertain(detail, candidate.at)
    if ((now - first_at).total_seconds() >= ATTENTION_AFTER_SECONDS
            and not bool(detail.get("attentionRaised"))):
        online = bool(result.get("runnerOnline"))
        reason = str(result.get("reason") or "")
        if reason == "offline":
            issue = "执行机当前离线"
        elif reason == "runner-restarted":
            issue = "执行机已经重启，旧进程回执无法再直接核实"
        elif reason == "inflight":
            issue = "执行机仍在准备工作目录或能力包"
        else:
            issue = "执行机暂时无法给出可靠回执"
        attention = {
            **detail,
            "summary": issue + "；为避免重复执行，SoduWork 没有自动重派",
            "nextAction": "请让原执行机恢复在线继续核对；确认需求未启动后再重新安排执行",
            "attentionRaised": True,
            "runnerOnline": online,
            "observedBootId": observed_boot,
            "probeReason": reason,
            "firstUncertainAt": _iso(first_at),
            "retryable": False,
            "uncertain": True,
        }
        task_events.record(
            session, task.id, ai_exec.EV_DISPATCH_UNCERTAIN, attention, actor="SoduWork")
        return "attention", task
    return "pending", task


async def _publish(session: AsyncSession, task: models.Task, action: str) -> None:
    from .tasks import task_to_api_live

    if task.owner_client_id:
        try:
            await publish_task(session, task, "task.updated", await task_to_api_live(session, task))
        except Exception as error:  # noqa: BLE001
            log.warning("派活对账状态推送失败 task=%s error=%s", task.id[:8], type(error).__name__)
    if action == "released":
        if task.status == "cancel":
            sources = await session.scalars(select(models.Task).where(models.Task.id.in_(
                select(models.Milestone.src_task_id).where(models.Milestone.task_id == task.id))))
            for source in sources:
                await publish_task(session, source, "task.updated", await task_to_api_live(session, source))
        await notify.notify_task(
            session, task,
            ("执行机已确认本批次未启动，可以重新安排源任务。" if task.status == "cancel"
             else "执行机已确认需求没有启动，已安全退回待办，可以重新安排执行。"),
            extra={"kind": "dispatch-released"})
    elif action == "attention":
        await notify.notify_task(
            session, task,
            "执行机回执长时间未确认。为避免重复执行，SoduWork 没有自动重派；请检查原执行机。",
            extra={"kind": "dispatch-attention"})


async def reconcile_once(*, now: datetime | None = None,
                         limit: int = BATCH_SIZE) -> dict[str, int]:
    """Run one bounded sweep without keeping a database transaction across RPC."""
    async with SessionLocal() as session:
        pending = await candidates(session, now=now, limit=limit)
    counts = {"candidates": len(pending), "confirmed": 0, "released": 0,
              "attention": 0, "pending": 0, "stale": 0, "errors": 0}
    for candidate in pending:
        try:
            result = await probe(candidate)
            async with SessionLocal() as session:
                action, task = await apply_probe(session, candidate, result, now=now)
                if action in {"confirmed", "released", "attention"}:
                    await session.commit()
                    if task is not None:
                        await _publish(session, task, action)
                else:
                    await session.rollback()
            counts[action] = counts.get(action, 0) + 1
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - one task must not stop the sweep
            counts["errors"] += 1
            log.warning("派活回执对账失败 task=%s error=%s",
                        candidate.task_id[:8], type(error).__name__)
    return counts


async def tick_loop() -> None:
    """Background loop shared by single- and multi-Hub deployments."""
    while True:
        try:
            result = await reconcile_once()
            changed = result["confirmed"] + result["released"] + result["attention"]
            if changed:
                log.info("派活回执对账：确认 %d，安全退回 %d，需关注 %d",
                         result["confirmed"], result["released"], result["attention"])
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001
            log.warning("派活回执对账循环异常: %s: %s", type(error).__name__, error)
        await asyncio.sleep(SWEEP_SECONDS)
