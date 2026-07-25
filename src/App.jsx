import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Icons } from './components/Icons.jsx';
import { MainView } from './views/MainView.jsx';
import { KeyConfigurationView, SLEEP_TIME_TO_SEC } from './views/KeyConfigurationView.jsx';
import { PerformanceView } from './views/PerformanceView.jsx';
import { FirmwareView } from './views/FirmwareView.jsx';
import { WebHIDService, ConfigStatus, VENDOR_ID } from './services/WebHIDService.js';

const BASE_TABS = ['Main', 'Key Configuration', 'Performance'];

// Map a power_cfg/sleep_time value (seconds) back to the nearest dropdown label.
function secToSleepLabel(sec) {
  const entries = Object.entries(SLEEP_TIME_TO_SEC);
  let best = entries[0];
  for (const e of entries) {
    if (Math.abs(e[1] - sec) < Math.abs(best[1] - sec)) best = e;
  }
  return best[0];
}

export default function App() {
  const [activeTab, setActiveTab] = useState('Main');
  const [device, setDevice] = useState(null);
  const [isDongle, setIsDongle] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Mouse not connected.');
  const [isSyncing, setIsSyncing] = useState(false);
  const [batteryLevel, setBatteryLevel] = useState(null);
  // Firmware tab renders for any attached device. Wired-mouse handles target
  // the mouse's DFU module (recipient=0); dongle handles (PID 0xF***) target
  // the dongle's local DFU module (recipient=2) via the SPI bridge.
  const isWiredMouse = !!device && !isDongle;
  const tabs = useMemo(() => (device ? [...BASE_TABS, 'Firmware'] : BASE_TABS), [device]);
  // Pause the 30 s battery poll while a DFU is in flight (concurrent FETCHes
  // would race the DFU sync polling and starve chunks).
  const [isUpdating, setIsUpdating] = useState(false);
  // React 18 StrictMode invokes the mount useEffect twice in dev. Both calls
  // race past the `!device` check (state batching hides the setDevice from the
  // second closure), then both kick off fetchSettings -- doubling the 11
  // serial FETCHes through the _enqueue mutex. A ref is the right tool here
  // because we need a synchronous flag visible between the two effect runs.
  const syncInFlightRef = useRef(false);

  const [config, setConfig] = useState({
    keyConfig: {
      motionSync: false,
      debounceTime: '0 ms',
      sleepTime: '1 min',
      profile: 'Profile 1 (Onboard)',
      // Per-button action codes for all 6 remappable buttons (Left, Right,
      // Middle, Back, Forward, DPI Loop). 0=Disabled, 1=Left, 2=Right,
      // 3=Middle, 4=Back, 5=Forward, 9=DPI Loop.
      keymap: [1, 2, 3, 4, 5, 9],
    },
    performance: {
      dpiStages: 4,
      dpis: [
        { id: 1, color: 'bg-red-600', active: true, value: 400, max: 26000 },
        { id: 2, color: 'bg-[#00ff00]', active: false, value: 800, max: 26000 },
        { id: 3, color: 'bg-blue-600', active: false, value: 1600, max: 26000 },
        { id: 4, color: 'bg-purple-600', active: false, value: 3200, max: 26000 },
      ],
      pollingRate: '1000',
      lod: '1mm',
      ripple: false,
      angleSnapping: false,
    },
  });

  const updateKeyConfig = useCallback((key, value) => {
    setConfig((prev) => ({
      ...prev,
      keyConfig: { ...prev.keyConfig, [key]: value },
    }));
  }, []);

  const updatePerformanceConfig = useCallback((key, value) => {
    setConfig((prev) => ({
      ...prev,
      performance: { ...prev.performance, [key]: value },
    }));
  }, []);

  const fetchSettings = async () => {
    console.log('[App] fetchSettings initiated.');
    // getConfig resolves null rather than throwing when responses stop, so a
    // sync against a closed handle burns the full 200 x 20 ms timeout on every
    // option -- ~48 s of apparent hang. Bail out instead; the HID connect
    // handler re-syncs once the device is back.
    if (!WebHIDService.device || !WebHIDService.device.opened) {
      console.warn('[App] fetchSettings skipped: device handle is not open.');
      return;
    }
    // Enumerated is not the same as ready: after a factory reset USB comes back
    // before the config channel answers. Syncing then returns null for every
    // option, and each field falls back to its previous value -- the UI silently
    // keeps pre-reset settings. Wait for a real response first.
    if (!(await WebHIDService.waitUntilResponsive())) {
      console.warn('[App] fetchSettings aborted: device not responding.');
      setStatusMessage('Device not responding. Try reconnecting.');
      return;
    }
    const failures = [];
    try {
      setIsSyncing(true);
      setStatusMessage('Syncing settings from mouse...');

      const MOD_MOTION = 'motion/paw3395';

      const fetchAndLog = async (module, option) => {
        const value = await WebHIDService.getConfig(module, option);
        if (value === null && WebHIDService.lastStatus !== ConfigStatus.SUCCESS) {
          failures.push(`${option}: ${WebHIDService.statusToMessage(WebHIDService.lastStatus)}`);
        }
        return value;
      };

      console.log('[App] Fetching DPI settings...');
      const stage1 = await fetchAndLog(MOD_MOTION, 'cpi_stage_1');
      const stage2 = await fetchAndLog(MOD_MOTION, 'cpi_stage_2');
      const stage3 = await fetchAndLog(MOD_MOTION, 'cpi_stage_3');
      const stage4 = await fetchAndLog(MOD_MOTION, 'cpi_stage_4');
      const activeStage = await fetchAndLog(MOD_MOTION, 'cpi_stage_active');
      await fetchAndLog(MOD_MOTION, 'cpi');

      console.log('[App] Fetching Performance settings...');
      // Read the rate for the transport actually in use. Derived from the live
      // device rather than the isWiredMouse state: setIsDongle() runs just
      // before this call, so the state closure would still hold the previous
      // render's value on first connect.
      const hidDev = WebHIDService.device;
      const wired = hidDev ? (hidDev.productId & 0xf000) !== 0xf000 : false;
      const pollRate = await fetchAndLog('polling', wired ? 'poll_usb' : 'poll_esb');
      const lodVal = await fetchAndLog(MOD_MOTION, 'lod');
      const rippleVal = await fetchAndLog(MOD_MOTION, 'ripple_control');
      const snapVal = await fetchAndLog(MOD_MOTION, 'angle_snap');

      console.log('[App] Fetching Key Configuration settings...');
      const motionSyncVal = await fetchAndLog(MOD_MOTION, 'motion_sync');
      const debounceMsVal = await fetchAndLog('buttons_cfg', 'debounce_ms');
      const sleepTimeSecVal = await fetchAndLog('power_cfg', 'sleep_time');
      const keymapVals = [];
      for (let i = 1; i <= 6; i++) {
        keymapVals.push(await fetchAndLog('buttons_cfg', `keymap_btn_${i}`));
      }
      const activeSlotVal = await fetchAndLog('profile', 'active_slot');

      console.log('[App] Fetching Battery level...');
      const batLevel = await WebHIDService.getConfig('battery_meas', 'bat_level');
      console.log('[App] batLevel:', batLevel);
      if (batLevel !== null) setBatteryLevel(batLevel);

      setConfig((prev) => {
        const newDpis = prev.performance.dpis.map((d) => ({ ...d }));
        if (stage1 !== null) newDpis[0].value = stage1;
        if (stage2 !== null) newDpis[1].value = stage2;
        if (stage3 !== null) newDpis[2].value = stage3;
        if (stage4 !== null) newDpis[3].value = stage4;

        if (activeStage !== null) {
          newDpis.forEach((d, i) => {
            d.active = i + 1 === activeStage;
          });
        }

        return {
          ...prev,
          performance: {
            ...prev.performance,
            dpis: newDpis,
            pollingRate: pollRate !== null ? String(pollRate) : prev.performance.pollingRate,
            lod: lodVal !== null ? (lodVal === 1 ? '1mm' : '2mm') : prev.performance.lod,
            ripple: rippleVal === 1,
            angleSnapping: snapVal === 1,
          },
          keyConfig: {
            ...prev.keyConfig,
            motionSync: motionSyncVal === 1,
            debounceTime:
              debounceMsVal !== null
                ? `${debounceMsVal} ms`
                : prev.keyConfig.debounceTime,
            sleepTime:
              sleepTimeSecVal !== null
                ? secToSleepLabel(sleepTimeSecVal)
                : prev.keyConfig.sleepTime,
            keymap: keymapVals.map((v, i) =>
              v !== null ? v : prev.keyConfig.keymap[i]
            ),
            profile:
              activeSlotVal !== null
                ? activeSlotVal === 0
                  ? 'Profile 1 (Onboard)'
                  : `Profile ${activeSlotVal + 1}`
                : prev.keyConfig.profile,
          },
        };
      });
      if (failures.length > 0) {
        console.warn('[App] Sync incomplete:', failures);
        setStatusMessage(`Sync incomplete (${failures.length} option${failures.length === 1 ? '' : 's'})`);
      } else {
        setStatusMessage(`Connected: ${WebHIDService.device.productName}`);
        console.log('[App] Settings Synced Successfully');
      }
    } catch (e) {
      console.error('[App] Failed to sync settings', e);
      setStatusMessage('Sync failed. Try reconnecting.');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleProtocolError = useCallback((label, reason) => {
    setStatusMessage(`${label}: ${reason}`);
  }, []);


  // force: re-sync even when a device is already held. A wired factory reset
  // reboots the mouse, and WebHID may hand back the same HIDDevice object on
  // re-enumeration -- and the disconnect handler only clears `device` when the
  // event carries that exact object, so it often stays set. Gating purely on
  // `!device` therefore skipped the sync and left the UI showing pre-reset
  // values until the page was reloaded.
  const syncFromAttachedDevice = useCallback(async (force = false) => {
    if (WebHIDService.isConnecting) return;
    // A forced sync (post-reset, or a device that just re-appeared) carries
    // information the in-flight one does not: that sync may have started while
    // the device was still rebooting and be reading nothing. Wait it out rather
    // than dropping the request, which left the UI stale after every wired
    // factory reset.
    if (syncInFlightRef.current) {
      if (!force) return;
      const waitUntil = Date.now() + 60000;
      while (syncInFlightRef.current && Date.now() < waitUntil) {
        await new Promise((r) => setTimeout(r, 250));
      }
      if (syncInFlightRef.current) {
        console.warn('[App] forced sync gave up waiting for the in-flight one.');
        return;
      }
    }
    syncInFlightRef.current = true;
    try {
      const connectedDevice = await WebHIDService.checkConnection();
      if (!connectedDevice) return;
      if (force || !device || connectedDevice.device !== device) {
        setDevice(connectedDevice.device);
        setIsDongle(connectedDevice.isDongle);
        await fetchSettings();
      }
    } finally {
      syncInFlightRef.current = false;
    }
  }, [device]);

  // Resync handed to views. Must route through syncFromAttachedDevice rather
  // than fetchSettings: after a wired factory reset the held handle is closed,
  // and only checkConnection() re-acquires and re-opens it. fetchSettings on
  // its own would hit the closed-handle guard and silently no-op.
  const resyncDevice = useCallback(
    () => syncFromAttachedDevice(true),
    [syncFromAttachedDevice]
  );

  useEffect(() => {
    if (!navigator.hid) return;

    syncFromAttachedDevice();

    const onHidConnect = (event) => {
      if (event.device.vendorId !== VENDOR_ID) return;
      // A connect event means the device just (re-)appeared, so its settings
      // may differ from what is on screen -- e.g. a wired factory reset.
      // Always re-read rather than trusting the handle we already hold.
      syncFromAttachedDevice(true);
    };

    const onHidDisconnect = (event) => {
      if (event.device.vendorId !== VENDOR_ID) return;
      if (!device || event.device !== device) return;
      setDevice(null);
      setBatteryLevel(null);
      setStatusMessage('Mouse Disconnected.');
    };

    navigator.hid.addEventListener('connect', onHidConnect);
    navigator.hid.addEventListener('disconnect', onHidDisconnect);
    return () => {
      navigator.hid.removeEventListener('connect', onHidConnect);
      navigator.hid.removeEventListener('disconnect', onHidDisconnect);
    };
  }, [device, syncFromAttachedDevice]);

  useEffect(() => {
    if (!device) return;
    if (isUpdating) return; // DFU owns the channel; skip battery polling

    const refreshBattery = async () => {
      if (document.visibilityState !== 'visible') return;
      if (WebHIDService.isConnecting || isSyncing) return;
      try {
        const batLevel = await WebHIDService.getConfig('battery_meas', 'bat_level');
        if (batLevel !== null) setBatteryLevel(batLevel);
      } catch {
        // ignore — disconnect handler clears state separately
      }
    };

    const intervalId = setInterval(refreshBattery, 30000);
    return () => clearInterval(intervalId);
  }, [device, isSyncing, isUpdating]);

  // While the Performance tab is open, poll the active CPI stage so a physical
  // DPI-Loop button press (which cycles cpi_stage_active in firmware) is
  // reflected in the highlighted DPI stage. WebHID has no push channel, so we
  // poll; scoped to the Performance tab to avoid idle background traffic.
  useEffect(() => {
    if (activeTab !== 'Performance') return;
    if (!device || isUpdating) return;

    const refreshActiveStage = async () => {
      if (document.visibilityState !== 'visible') return;
      if (WebHIDService.isConnecting || isSyncing) return;
      try {
        const stage = await WebHIDService.getConfig('motion/paw3395', 'cpi_stage_active');
        if (stage === null) return;
        setConfig((prev) => {
          const cur = prev.performance.dpis.findIndex((d) => d.active) + 1;
          if (cur === stage) return prev;
          return {
            ...prev,
            performance: {
              ...prev.performance,
              dpis: prev.performance.dpis.map((d, i) => ({ ...d, active: i + 1 === stage })),
            },
          };
        });
      } catch {
        // ignore — disconnect handler clears state separately
      }
    };

    refreshActiveStage();
    const intervalId = setInterval(refreshActiveStage, 1000);
    return () => clearInterval(intervalId);
  }, [activeTab, device, isSyncing, isUpdating]);

  // If the Firmware tab is active but the user unplugs the device, bounce
  // back to Main so we don't strand them on a tab without a target.
  useEffect(() => {
    if (activeTab === 'Firmware' && !device) {
      setActiveTab('Main');
    }
  }, [activeTab, device]);

  const connectMouse = async () => {
    if (device) {
      await WebHIDService.disconnect();
      setDevice(null);
      setStatusMessage('Disconnected.');
      return;
    }

    setStatusMessage('Requesting device...');
    WebHIDService.isConnecting = true;
    try {
      const connectedDevice = await WebHIDService.connect();
      if (connectedDevice) {
        console.log('[App] Reading Device Info...');
        const boardName = await WebHIDService.getBoardName();
        const hwid = await WebHIDService.getHWID();

        console.log(`[App] Board Name: ${boardName}`);
        console.log(`[App] HWID: ${hwid}`);

        setDevice(connectedDevice.device);
        setIsDongle(connectedDevice.isDongle);
        await fetchSettings();
      }
    } catch (e) {
      setDevice(null);
      setStatusMessage(`Connection Error: ${e.message}`);
    } finally {
      WebHIDService.isConnecting = false;
    }
  };

  const handlePairing = async () => {
    const confirmed = window.confirm('Are you sure you want to enter pairing mode?');
    if (confirmed) {
      try {
        console.log('[App] Attempting to start pairing...');
        await WebHIDService.startPairing();
        alert('Pairing Request Sent');
      } catch (e) {
        console.error('[App] Pairing failed:', e);
        alert('Pairing Failed: ' + e.message);
      }
    }
  };

  const isConnected = !!device;
  const connectButtonText = isConnected ? 'Disconnect' : 'Connect Mouse';
  const connectButtonClass = isConnected
    ? 'bg-statusDanger hover:bg-red-500'
    : 'bg-statusInfo hover:bg-blue-400';

  return (
    <div className="flex items-center justify-center min-h-screen bg-black font-sans text-gray-100 selection:bg-gray-700 p-8">
      <div className="w-[900px] h-[640px] bg-panelDark rounded-lg shadow-2xl flex flex-col overflow-hidden border border-borderDark relative ring-1 ring-white/5">
        <div className="flex flex-col select-none z-20 bg-panelDark border-b border-borderDark">
          <div className="h-10 flex items-center justify-between px-6">
            <div className="flex items-center gap-4">
              <div className="text-lg text-white tracking-widest opacity-90">Hitscan Configurator</div>
            </div>
            <div className="flex items-center gap-5">
              {isDongle && (
                <button
                  onClick={handlePairing}
                  className="text-gray-400 hover:text-white cursor-pointer transition-colors p-1"
                  title="Pair Device"
                >
                  <Icons.Wireless />
                </button>
              )}
              <div className="text-gray-400 hover:text-white cursor-pointer transition-colors"><Icons.Settings /></div>
              <div className="text-gray-400 hover:text-white cursor-pointer transition-colors"><Icons.Minus /></div>
              <div className="text-gray-400 hover:text-white cursor-pointer transition-colors"><Icons.X /></div>
            </div>
          </div>

          <div className="flex items-center justify-between px-8 h-12">
            <div className="flex gap-10 h-full">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`h-full flex items-center text-xs font-bold tracking-wide transition-all duration-300 relative ${
                    activeTab === tab ? 'text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {tab}
                  {activeTab === tab && (
                    <span className="absolute bottom-0 left-0 w-full h-[2px] bg-gray-200 rounded-t-full shadow-[0_0_8px_rgba(255,255,255,0.4)]"></span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-4">
              <span
                className={`text-[10px] ${isSyncing ? 'text-yellow-400' : 'text-gray-500'} max-w-40 text-right truncate`}
                title={statusMessage}
              >
                {isSyncing ? 'Syncing...' : statusMessage}
              </span>

              <button
                onClick={connectMouse}
                className={`text-black text-xs font-bold py-2 px-4 rounded transition-all shadow-md ${connectButtonClass}`}
              >
                {connectButtonText}
              </button>

              <div className="flex items-center gap-1.5 text-statusSuccess text-xs font-bold ml-2">
                <Icons.Battery />
                <span>{batteryLevel !== null ? `${batteryLevel}%` : '---'}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 bg-panelDark relative overflow-hidden">
          {activeTab === 'Main' && <MainView />}
          {activeTab === 'Key Configuration' && (
            <KeyConfigurationView
              config={config}
              updateConfig={(k, v) => updateKeyConfig(k, v)}
              onProtocolError={handleProtocolError}
              onResync={resyncDevice}
              isWiredMouse={isWiredMouse}
            />
          )}
          {activeTab === 'Performance' && (
            <PerformanceView
              config={config}
              updateConfig={(k, v) => updatePerformanceConfig(k, v)}
              onProtocolError={handleProtocolError}
              isWiredMouse={isWiredMouse}
            />
          )}
          {activeTab === 'Firmware' && device && (
            <FirmwareView
              onProtocolError={handleProtocolError}
              onUpdatingChange={setIsUpdating}
              isDongle={isDongle}
            />
          )}
        </div>
      </div>
    </div>
  );
}
