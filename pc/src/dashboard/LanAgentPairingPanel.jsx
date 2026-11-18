import React, { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import Card from "../shell/Card.jsx";
import "./wifi-pairing.css";
import { publishLanAgentPairing, readLanAgentPairing } from "./lanAgentPairing.js";
import { useExitProtection } from "../lib/exit-protection.js";

const volumeMessages = {
  applying: "设备正在等待音频空闲。",
  failed: "设备未能读回实际音量。",
  cancelled: "音量请求已取消或过期。",
  unknown: "设备没有返回可确认的结果。请查看设备，或查询结果。",
};

async function readControlStatus(usbConnected, onStatus) {
  const status = await invoke("lan_device_status");
  onStatus?.(status);
  if (usbConnected && status.rebootSupported && !status.controlTrusted) {
    try {
      await invoke("lan_trust_usb");
      return await invoke("lan_device_status");
    } catch {
      return status;
    }
  }
  return status;
}

export default function LanAgentPairingPanel({ usb, active = true }) {
  const [address,setAddress]=useState(null), [devices,setDevices]=useState([]), [selected,setSelected]=useState(null);
  const [busy,setBusy]=useState(""),[error,setError]=useState(""),[scanned,setScanned]=useState(false);
  const initialScan = useRef(false);
  const [pairingLoaded, setPairingLoaded] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [deliveryMessage, setDeliveryMessage] = useState("");
  const [rebootMessage, setRebootMessage] = useState("");
  const [otaMessage, setOtaMessage] = useState("");
  const [volume, setVolume] = useState("");
  const [volumeRequest, setVolumeRequest] = useState(null);
  const canRequestVolume = /^[0-9]{1,3}$/.test(volume) && Number(volume) <= 100;
  const volumeRequestId = volumeRequest?.id;
  const awaitingVolume = volumeRequest?.result === "applying" || volumeRequest?.result === "unknown";
  useEffect(() => {
    if (!volumeRequestId || !awaitingVolume) return;
    let alive = true;
    let timer;
    const deadline = Date.now() + 10_000;
    const poll = async () => {
      try {
        const result = await invoke("lan_volume_result", {id: volumeRequestId});
        if (!alive) return;
        if (result !== "unknown" && result !== "applying") {
          setVolumeRequest(current => current?.id === volumeRequestId ? {...current, result} : current);
          return;
        }
      } catch {
        if (!alive) return;
      }
      if (Date.now() < deadline) timer = setTimeout(poll, 700);
    };
    timer = setTimeout(poll, 700);
    return () => { alive = false; clearTimeout(timer); };
  }, [volumeRequestId, awaitingVolume]);

  const usbConnected = Boolean(usb?.connected);
  const canMutateOverLan = !usbConnected && Boolean(address && deviceStatus?.controlTrusted);
  const usbConnectionId = usb?.connectionId;
  useEffect(() => {
    if (!address) return;
    let alive = true;
    const updateStatus = status => { if (alive) setDeviceStatus(status); };
    readControlStatus(usbConnected, updateStatus).then(updateStatus).catch(() => {});
    return () => { alive = false; };
  }, [address, usbConnected, usbConnectionId]);
  useExitProtection(busy === "pair" ? "正在完成设备配对" : busy === "install" ? "正在通过 Wi-Fi 安装组件" : busy === "reboot" ? "正在确认设备重启" : busy === "ota" ? "正在通过 Wi-Fi 升级设备" : "");
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending || busy) return;
      pending = true;
      try {
        const saved = await readLanAgentPairing();
        if (alive) {
          setAddress(saved);
          setPairingLoaded(true);
        }
      } catch {
        if (alive) setError("配对记录读取失败，原记录已保留。请重试。");
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active, busy]);
  const scan = useCallback(async () => {
    setBusy("scan");
    setError("");
    setSelected(null);
    try {
      setDevices(await invoke("lan_agent_discover"));
      setScanned(true);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
    }
  }, []);
  useEffect(() => {
    if (!active || initialScan.current) return;
    initialScan.current = true;
    void scan();
  }, [active, scan]);
  const pair = async () => {
    if (!selected || busy) return;
    setBusy("pair");
    setError("");
    try {
      const saved = await invoke("lan_agent_pair_confirm", { id: selected.id, ip: selected.ip });
      setDeviceStatus(null);
      setAddress(saved);
      setDeliveryMessage("");
      setRebootMessage("");
      setOtaMessage("");
      setVolumeRequest(null);
      publishLanAgentPairing(saved);
      setSelected(null);
      setDevices(current => current.map(device => device.id === selected.id && device.ip === selected.ip
        ? { ...device, ready: false, paired: true }
        : device));
      setDeviceStatus(await readControlStatus(usbConnected).catch(() => null));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy("");
    }
  };
  const checkStatus = async () => {
    setBusy("status");
    setError("");
    try {
      setDeviceStatus(await readControlStatus(usbConnected));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const sendVolume = async (event) => {
    event.preventDefault();
    if (!canMutateOverLan || busy || !canRequestVolume) return;
    setBusy("volume");
    setError("");
    setVolumeRequest(null);
    try {
      const [id, result] = await invoke("lan_volume_request", {expectedBootId: deviceStatus.bootId, volume: Number(volume)});
      setVolumeRequest({id, result, value: Number(volume)});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const checkVolume = async () => {
    if (!volumeRequest || busy) return;
    setBusy("volume-result");
    setError("");
    try {
      const result = await invoke("lan_volume_result", {id: volumeRequest.id});
      setVolumeRequest({...volumeRequest, result});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const chooseComponent = async () => {
    if (!canMutateOverLan || busy) return;
    setBusy("install");
    setError("");
    setDeliveryMessage("");
    try {
      const path = await openDialog({ filters: [{ name: "PetUI 组件", extensions: ["hachiapp", "clawpkg", "zip"] }] });
      if (typeof path !== "string") return;
      const preview = await invoke("lan_component_preview", {path});
      await invoke("lan_component_install", {path, ...preview});
      setDeliveryMessage("设备已提交安装。");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const rebootDevice = async () => {
    const expectedBootId = deviceStatus?.bootId;
    if (!canMutateOverLan || busy || !expectedBootId) return;
    setBusy("reboot");
    setError("");
    setRebootMessage("");
    try {
      const result = await invoke("lan_reboot", {expectedBootId});
      setDeviceStatus(result.observed);
      if (result.observed) {
        setRebootMessage(result.scheduled ? "设备已重启并重新上线。" : "已验证设备重新上线，启动 ID 已改变。");
      } else {
        setRebootMessage(result.scheduled
          ? "设备已安排重启，尚未读到新的启动 ID。"
          : "重启结果未确认。请查看设备，或重新读取状态。");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const updateFirmware = async () => {
    const expectedBootId = deviceStatus?.bootId;
    if (!canMutateOverLan || busy || !expectedBootId) return;
    setBusy("ota");
    setError("");
    setOtaMessage("");
    try {
      const version = await invoke("lan_update_bundled_firmware", {expectedBootId});
      setOtaMessage(`已通过 Wi-Fi 升级至 ${version}。`);
      try { setDeviceStatus(await invoke("lan_device_status")); }
      catch { setDeviceStatus(null); }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };
  const forget=async()=>{setBusy("forget");setError("");try{await invoke("lan_agent_forget");setAddress(null);setDeviceStatus(null);setDeliveryMessage("");setRebootMessage("");setOtaMessage("");setVolumeRequest(null);publishLanAgentPairing(null);}catch{setError("无法移除本机配对，请重试。");}finally{setBusy("");}};
  return <Card title="Wi-Fi 设备配对" subtitle="电脑与设备位于同一局域网时，可通过 Wi-Fi 同步。USB 接入时优先使用 USB。">
    <div className="wifi-pairing">
      <section className="wifi-pairing__current" aria-label="当前配对">
        <div>
          <h3>当前配对</h3>
          {address ? <>
            <strong>{deviceStatus?.boardDeviceId || address}</strong>
            <p className="muted small">{[
              deviceStatus?.boardDeviceId && address,
              deviceStatus?.firmware,
              deviceStatus && (deviceStatus.wifiConnected ? "设备 Wi-Fi 已连接" : "设备 Wi-Fi 未连接"),
              deviceStatus && (deviceStatus.clockSynchronized ? "已校时" : "待校时"),
            ].filter(Boolean).join(" · ") || "已保存配对"}</p>
          </> : <p role="status">{pairingLoaded ? "尚未配对，从下方选择设备。" : "正在读取配对记录…"}</p>}
        </div>
        {address && <button type="button" className="btn-secondary btn-sm" disabled={!!busy} onClick={checkStatus}>
          {busy === "status" ? "正在读取…" : "刷新状态"}
        </button>}
      </section>

      <section aria-label="附近设备">
        <div className="wifi-pairing__section-head">
          <h3>附近设备</h3>
          <button type="button" className="btn-secondary btn-sm" disabled={!!busy} onClick={scan}>
            {busy === "scan" ? "正在发现…" : "重新扫描"}
          </button>
        </div>
        <div className="wifi-pairing__list" role="radiogroup" aria-label="选择要配对的设备">
          {devices.map(device => {
            const isCurrent = Boolean(address && (deviceStatus?.boardDeviceId
              ? deviceStatus.boardDeviceId === device.id : address === device.ip));
            const label = isCurrent ? "当前配对" : device.ready ? "可配对"
              : !device.supportsAutomatic ? "需升级固件"
                : device.paired ? "已有配对" : "暂不可配对";
            return <label key={`${device.id}-${device.ip}`} className="wifi-pairing__device">
              <input type="radio" name="lan-device" disabled={!!busy || !device.ready || isCurrent}
                checked={selected?.id === device.id && selected?.ip === device.ip}
                onChange={() => setSelected(device)} />
              <span><strong>{device.id}</strong><small>{device.ip}</small></span>
              <span className="api-settings__status">{label}</span>
            </label>;
          })}
        </div>
        {scanned && !devices.length && <p role="status" className="muted">暂未发现设备。确认双方连在同一局域网，再重新扫描。</p>}
        {selected && <button type="button" className="btn-primary btn-sm" disabled={!!busy} onClick={pair}>确认配对</button>}
        {busy === "pair" && <p role="status">正在建立连接并保存配对。</p>}
      </section>

      <details>
        <summary>如何连接设备</summary>
        <ol>
          <li>在设备上长按 3 键，或从组件中心打开系统设置。</li>
          <li>进入 Wi-Fi 配置，选择网络并输入密码。</li>
          <li>让电脑加入同一局域网，在上方选择设备并确认配对。下次启动时，没有 USB 连接就会自动连接上次配对的设备。</li>
        </ol>
      </details>

      {address && <details>
        <summary>设备维护与配对管理</summary>
        {deviceStatus?.rebootSupported && !deviceStatus.controlTrusted &&
          <p role="status">连接同一台设备的 USB 后，桌面端会自动授权无线控制。</p>}
        <div className="wifi-pairing__actions">
          {canMutateOverLan && deviceStatus?.rebootSupported &&
            <button type="button" className="btn-secondary btn-sm" disabled={!!busy || !deviceStatus.bootId} onClick={rebootDevice}>
              {busy === "reboot" ? "等待设备上线…" : "无线重启"}
            </button>}
          {canMutateOverLan && deviceStatus?.wirelessOta &&
            <button type="button" className="btn-secondary btn-sm" disabled={!!busy || !deviceStatus.bootId} onClick={updateFirmware}>
              {busy === "ota" ? "正在升级…" : "无线更新固件"}
            </button>}
          {canMutateOverLan && deviceStatus?.componentDelivery &&
            <button type="button" className="btn-secondary btn-sm" disabled={!!busy} onClick={chooseComponent}>
              {busy === "install" ? "正在安装…" : "无线安装组件"}
            </button>}
          <button type="button" className="btn-secondary btn-sm" disabled={!!busy} onClick={forget}>忘记本机配对</button>
        </div>
        {canMutateOverLan && deviceStatus?.trustedVolume && <form className="wifi-pairing__actions" onSubmit={sendVolume}>
          <label className="ui-field">
            <span>设备音量（0–100%）</span>
            <input inputMode="numeric" maxLength={3} value={volume} onChange={event => setVolume(event.target.value)} disabled={!!busy} />
          </label>
          <button type="submit" className="btn-secondary btn-sm" disabled={!!busy || !canRequestVolume}>设置音量</button>
        </form>}
        {volumeRequest && <>
          <p role="status">{volumeRequest.result === "applied" ? `设备已确认音量为 ${volumeRequest.value}%。设置将在空闲时保存。` : volumeMessages[volumeRequest.result]}</p>
          <button type="button" className="btn-secondary btn-sm" disabled={!!busy} onClick={checkVolume}>查询音量结果</button>
        </>}
      </details>}
      {rebootMessage && <p role="status">{rebootMessage}</p>}
      {otaMessage && <p role="status">{otaMessage}</p>}
      {deliveryMessage && <p role="status">{deliveryMessage}</p>}
      {error && <p className="api-settings__result is-error" role="alert">{error}</p>}
    </div>
  </Card>;
}
