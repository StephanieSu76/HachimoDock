/**
 * [Input] Verified USB device snapshot, bundled-firmware metadata/update Tauri
 *         commands, firmware progress events, and toast feedback.
 * [Output] Sidebar-only firmware module: older devices show an inline Update
 *          button, equal/newer devices show non-interactive Up to date copy,
 *          and upgrades run in place without a detail page.
 * [Pos] app-shell sidebar node in pc/src/shell.
 * [Sync] If this file changes, update `pc/src/shell/.folder.md` and `pc/src/.folder.md`.
 */

import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, LoaderCircle } from "lucide-react";
import { currentFirmwareCompletion, firmwareUpdateDisposition } from "../lib/firmware-version.js";
import { useToast } from "./ToastStack.jsx";
import { useExitProtection } from "../lib/exit-protection.js";
import { firmwareAlreadyLatest, firmwareUpdateFailureMessage } from "../lib/firmware-update-error.js";

import { useDialogFocus } from "../component-center/use-dialog-focus.js";

function FirmwareBoardDialog({ onCancel, onConfirm }) {
  const [board, setBoard] = useState("");
  const dialogRef = useDialogFocus(onCancel);
  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        ref={dialogRef}
        className="modal-card firmware-board-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="firmware-board-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (board) onConfirm(board);
        }}
      >
        <div className="modal-header">
          <h3 id="firmware-board-title" className="modal-title">选择设备板型</h3>
        </div>
        <div className="modal-body">
          <p>暂时无法自动确认板型。请核对开发板上的型号标识后再选择。</p>
          <div className="firmware-board-dialog__options">
            {[["wifi6", "WiFi6"], ["pico", "Pico"]].map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="firmware-board-model"
                  value={value}
                  checked={board === value}
                  onChange={() => setBoard(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="channel-switch-confirm-modal__actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>取消</button>
          <button type="submit" className="btn-primary" disabled={!board}>开始更新</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export default function FirmwareUpdateNavItem({ usb = {} }) {
  const { push } = useToast();
  const [probe, setProbe] = useState(null);
  const [probeRefresh, setProbeRefresh] = useState(0);
  const [expiredProbe, setExpiredProbe] = useState(null);
  const [choosingBoard, setChoosingBoard] = useState(null);
  const [completed, setCompleted] = useState(null);
  const [pending, setPending] = useState(false);
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState("");
  const { boardDeviceId, connectionId, firmware } = usb;
  const reportedBoard = usb.capabilities?.firmwareUpdate?.hardwareBoardModel;
  const chipRevision = usb.capabilities?.firmwareUpdate?.chipRevision;
  const connectedP4 = usb.connected === true && usb.runtime === "esp-p4" && Boolean(boardDeviceId && connectionId);
  const hardwareProbePending = usb.capabilities?.firmwareUpdate?.hardwareBoardProbe === "pending";
  const probeKey = JSON.stringify([boardDeviceId, connectionId, firmware, reportedBoard, chipRevision, hardwareProbePending]);
  const awaitingBoardProbe = hardwareProbePending && expiredProbe !== probeKey;
  const currentProbe = connectedP4 && probe?.key === probeKey ? probe : null;
  const bundledFirmware = currentProbe?.info;
  const currentCompletion = currentFirmwareCompletion(usb, completed);
  const requiresBoardChoice = currentProbe?.info === null && !awaitingBoardProbe && !currentCompletion;
  const boardDialogOpen = requiresBoardChoice && choosingBoard === probeKey && !pending;
  const boardLabel = { wifi6: "WiFi6", pico: "Pico" }[bundledFirmware?.boardModel || currentCompletion?.boardModel];
  useExitProtection(pending ? "固件升级中，请等待设备重新连接并校验完成" : "");

  useEffect(() => {
    setChoosingBoard(null);
    if (!connectedP4) return;
    if (awaitingBoardProbe) {
      const timer = setTimeout(() => setExpiredProbe(probeKey), 2500);
      return () => clearTimeout(timer);
    }
    let cancelled = false;
    invoke("usb_get_bundled_firmware_info", {
      expectedBoardDeviceId: boardDeviceId,
      expectedConnectionId: connectionId,
    }).then((info) => {
      if (!cancelled) setProbe({ key: probeKey, info });
    }).catch(() => {
      if (!cancelled) setProbe({ key: probeKey, label: "暂不可更新" });
    });
    return () => {
      cancelled = true;
    };
  }, [connectedP4, probeKey, boardDeviceId, connectionId, awaitingBoardProbe, probeRefresh]);

  useEffect(() => {
    let cancelled = false;
    let unlisten = null;
    listen("usb-firmware-update-progress", (event) => {
      if (cancelled || !pending) return;
      const nextPercent = Math.max(0, Math.min(100, Number(event?.payload?.percent) || 0));
      setPercent(nextPercent);
      setStage(String(event?.payload?.stage || ""));
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch((error) => console.warn("[firmware-nav] progress unavailable", error));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [pending]);

  const currentVersion = currentCompletion?.version || String(bundledFirmware?.currentVersion || firmware || "");
  const stageLabel = ({begin:"准备升级",upload:"写入中",recover:"恢复连接",verify:"校验中",reboot:"等待重启",validate:"确认版本"})[stage] || "准备升级";
  const disposition = connectedP4
    ? firmwareUpdateDisposition(currentVersion, bundledFirmware?.version || currentCompletion?.version)
    : "unknown";

  const startUpdate = useCallback(async (confirmedBoardModel) => {
    if (pending || (requiresBoardChoice
      ? !boardDialogOpen || !confirmedBoardModel
      : disposition !== "update")) return;
    setChoosingBoard(null);
    setPending(true);
    setPercent(0);
    setStage("begin");
    try {
      const result = await invoke("usb_update_bundled_firmware", {
        expectedBoardDeviceId: boardDeviceId,
        expectedConnectionId: connectionId,
        ...(confirmedBoardModel ? { confirmedBoardModel } : {}),
      });
      setCompleted({
        boardDeviceId,
        connectionId: result?.connectionId,
        version: String(result?.version || bundledFirmware?.version || ""),
        boardModel: confirmedBoardModel || bundledFirmware?.boardModel,
      });
      setPercent(100);
      push({
        tone: "success",
        title: "设备固件已更新",
        message: `版本 ${result?.version || bundledFirmware?.version || "未知"} 已确认有效。`,
      });
    } catch (error) {
      if (firmwareAlreadyLatest(error)) {
        setProbe(null);
        setProbeRefresh((value) => value + 1);
        push({ tone: "info", title: "固件已是最新", message: "当前设备无需升级。" });
        return;
      }
      push({
        tone: "error",
        title: "固件升级未完成",
        message: firmwareUpdateFailureMessage(error),
      });
    } finally {
      setPending(false);
    }
  }, [bundledFirmware?.version, bundledFirmware?.boardModel, boardDeviceId, connectionId, disposition, pending, push, requiresBoardChoice, boardDialogOpen]);

  return (
    <div
      className="sidebar-nav__item sidebar-firmware-update"
      aria-label="固件升级"
      title={bundledFirmware?.version
        ? `${boardLabel} · 设备 ${currentVersion || "未知"} · 内置 ${bundledFirmware.version}`
        : "固件升级"}
    >
      {pending ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
      <span className="sidebar-nav-label">固件升级</span>
      {boardLabel && <span className="sidebar-firmware-update__board">{boardLabel}</span>}
      {connectedP4 && !pending && !boardLabel && !requiresBoardChoice && disposition !== "latest" && (
        <span className="sidebar-firmware-update__latest" role="status">
          {currentProbe?.label || "正在识别"}
        </span>
      )}
      {(pending || disposition === "update" || requiresBoardChoice) && (
        <button
          type="button"
          className="sidebar-firmware-update__action"
          onClick={() => {
            if (requiresBoardChoice) setChoosingBoard(probeKey);
            else startUpdate();
          }}
          disabled={pending}
        >
          {pending ? `${stageLabel}${stage === "upload" ? ` ${percent}%` : "…"}` : "更新"}
        </button>
      )}
      {boardDialogOpen && (
        <FirmwareBoardDialog onCancel={() => setChoosingBoard(null)} onConfirm={startUpdate} />
      )}
      {!pending && disposition === "latest" && (
        <span className="sidebar-firmware-update__latest">已最新</span>
      )}
    </div>
  );
}
