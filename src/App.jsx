import React, { useState, useEffect, useCallback } from 'react';
import { WebHIDService, ConnectionMode } from './services/WebHIDService';
import { McubootImage } from './services/McubootImage';
import { Icons } from './components/Icons';
import { MainView } from './views/MainView';
import { KeyConfigurationView } from './views/KeyConfigurationView';
import { PerformanceView } from './views/PerformanceView';
import { SettingsPanel } from './views/SettingsPanel';

function App() {
    const [activeTab, setActiveTab] = useState('Main');
    const tabs = ['Main', 'Key Configuration', 'Performance'];

    // WebHID State
    const [device, setDevice] = useState(null);
    const [connectionMode, setConnectionMode] = useState(null);
    const [statusMessage, setStatusMessage] = useState('Mouse not connected.');
    const isDongle = connectionMode === ConnectionMode.WIRELESS;
    const [isSyncing, setIsSyncing] = useState(false);
    const [batteryLevel, setBatteryLevel] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [deviceInfo, setDeviceInfo] = useState({ boardName: null, hwid: null, fwVersion: null, bootloader: null });

    // Shared Configuration State 
    const [config, setConfig] = useState({
        keyConfig: {
            motionSync: false,
            debounceTime: '0 ms',
            autoSleep: false,
            sleepTime: '1 min',
            profile: 'Profile 1 (Onboard)'
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
        }
    });

    const updateKeyConfig = useCallback((key, value) => {
        setConfig(prev => ({
            ...prev,
            keyConfig: { ...prev.keyConfig, [key]: value }
        }));
    }, []);

    const updatePerformanceConfig = useCallback((key, value) => {
        setConfig(prev => ({
            ...prev,
            performance: { ...prev.performance, [key]: value }
        }));
    }, []);

    // Pulls board name, HWID, firmware version, and bootloader variant.
    // Called on every connect (manual + auto via HID events) so the Settings
    // panel always sees fresh values. Serial — the HID feature-report
    // transport is single-slot and parallel requests collide on the wire.
    const fetchDeviceInfo = async () => {
        try {
            const boardName = await WebHIDService.getBoardName();
            const hwid = await WebHIDService.getHWID();
            const fwinfo = await WebHIDService.dfuFwInfo({ timeoutMs: 1500 });
            const bootloader = await WebHIDService.dfuVariant({ timeoutMs: 1500 });
            console.log("[App] device info:", { boardName, hwid, fwinfo, bootloader });
            setDeviceInfo({
                boardName,
                hwid,
                fwVersion: fwinfo ? McubootImage.formatVersion(fwinfo.version) : null,
                bootloader: bootloader || null,
            });
        } catch (e) {
            console.warn("[App] fetchDeviceInfo failed:", e);
        }
    };

    // Sync Logic
    const fetchSettings = async () => {
        console.log("[App] fetchSettings initiated.");
        try {
            setIsSyncing(true);
            setStatusMessage('Syncing settings from mouse...');

            const MOD_MOTION = 'motion/paw3395';

            const fetchAndLog = async (module, option) => {
                const val = await WebHIDService.getConfig(module, option);
                return val;
            };

            console.log("[App] Fetching DPI settings...");
            const stage1 = await fetchAndLog(MOD_MOTION, 'cpi_stage_1');
            const stage2 = await fetchAndLog(MOD_MOTION, 'cpi_stage_2');
            const stage3 = await fetchAndLog(MOD_MOTION, 'cpi_stage_3');
            const stage4 = await fetchAndLog(MOD_MOTION, 'cpi_stage_4');
            const activeStage = await fetchAndLog(MOD_MOTION, 'cpi_stage_active');

            const currentCpi = await fetchAndLog(MOD_MOTION, 'cpi');

            console.log("[App] Fetching Performance settings...");
            const pollRate = await fetchAndLog(MOD_MOTION, 'poll_esb');
            const lodVal = await fetchAndLog(MOD_MOTION, 'lod');
            const rippleVal = await fetchAndLog(MOD_MOTION, 'ripple_control');
            const snapVal = await fetchAndLog(MOD_MOTION, 'angle_snap');
            const motionSyncVal = await fetchAndLog(MOD_MOTION, 'motion_sync');

            console.log("[App] Fetching Battery level...");
            // Battery is non-critical — cap timeout so a stalled response doesn't hold up the rest of the sync.
            const batLevel = await WebHIDService.getConfig('battery_meas', 'bat_level', { timeoutMs: 400 });
            console.log("[App] batLevel:", batLevel);
            if (batLevel !== null) {
                setBatteryLevel(batLevel);
            }

            setConfig(prev => {
                const newDpis = prev.performance.dpis.map(d => ({ ...d }));
                if (stage1 !== null) newDpis[0].value = stage1;
                if (stage2 !== null) newDpis[1].value = stage2;
                if (stage3 !== null) newDpis[2].value = stage3;
                if (stage4 !== null) newDpis[3].value = stage4;

                if (activeStage !== null) {
                    newDpis.forEach((d, i) => d.active = (i + 1) === activeStage);
                }

                console.log("[App] Updating state with new config.");

                return {
                    ...prev,
                    keyConfig: {
                        ...prev.keyConfig,
                        motionSync: motionSyncVal === 1
                    },
                    performance: {
                        ...prev.performance,
                        dpis: newDpis,
                        pollingRate: pollRate !== null ? String(pollRate) : prev.performance.pollingRate,
                        lod: lodVal !== null ? (lodVal === 1 ? '1mm' : '2mm') : prev.performance.lod,
                        ripple: rippleVal === 1,
                        angleSnapping: snapVal === 1
                    }
                };
            });
            setStatusMessage(`Connected: ${WebHIDService.device.productName}`);
            console.log("[App] Settings Synced Successfully");
        } catch (e) {
            console.error("[App] Failed to sync settings", e);
            setStatusMessage('Sync failed. Try reconnecting.');
        } finally {
            setIsSyncing(false);
        }
    };

    // Connection Logic
    const pollConnectionStatus = useCallback(async () => {
        if (WebHIDService.isConnecting) return;

        const connectedDevice = await WebHIDService.checkConnection();

        if (connectedDevice) {
            // Handle three transitions: first connect, swap to a higher-priority device,
            // and no-op when nothing changed.
            if (!device || device !== connectedDevice.device) {
                setDevice(connectedDevice.device);
                setConnectionMode(connectedDevice.mode);
                // Don't kick the 12-roundtrip settings sync while DFU owns the
                // config-channel — the SettingsPanel verify step is polling
                // dfuFwInfo on this same device and they'd race.
                if (!WebHIDService.dfuInProgress) {
                    fetchDeviceInfo();
                    fetchSettings();
                }
            }
        } else if (device) {
            setDevice(null);
            setConnectionMode(null);
            setStatusMessage('Mouse Disconnected.');
        }
    }, [device]);

    useEffect(() => {
        pollConnectionStatus();
        const intervalId = setInterval(pollConnectionStatus, 5000);
        const removeListeners = WebHIDService.addEventListeners(pollConnectionStatus);
        return () => {
            clearInterval(intervalId);
            removeListeners();
        };
    }, [pollConnectionStatus]);

    const connectMouse = async () => {
        if (device) {
            await WebHIDService.disconnect();
            setDevice(null);
            setConnectionMode(null);
            setStatusMessage('Disconnected.');
            return;
        }

        setStatusMessage('Requesting device...');
        WebHIDService.isConnecting = true;
        try {
            const connectedDevice = await WebHIDService.connect();
            if (connectedDevice) {
                setDevice(connectedDevice.device);
                setConnectionMode(connectedDevice.mode);
                await fetchDeviceInfo();
                await fetchSettings();
            }
        } catch (e) {
            setDevice(null);
            setConnectionMode(null);
            setStatusMessage(`Connection Error: ${e.message}`);
        } finally {
            WebHIDService.isConnecting = false;
        }
    };

    const handlePairing = async () => {
        const confirmed = window.confirm("Are you sure you want to enter pairing mode?");
        if (confirmed) {
            try {
                console.log("[App] Attempting to start pairing...");
                await WebHIDService.startPairing();
                alert('Pairing Request Sent');
            } catch (e) {
                console.error("[App] Pairing failed:", e);
                alert('Pairing Failed: ' + e.message);
            }
        }
    };

    const isConnected = !!device;
    const connectButtonText = isConnected ? 'Disconnect' : 'Connect Mouse';
    const connectButtonClass = isConnected ? 'bg-statusDanger hover:bg-red-500' : 'bg-statusInfo hover:bg-blue-400';

    return (
        <div className="flex items-center justify-center min-h-screen bg-black font-sans text-gray-100 selection:bg-gray-700 p-8">
            <div className="w-[900px] h-[640px] bg-panelDark rounded-lg shadow-2xl flex flex-col overflow-hidden border border-borderDark relative ring-1 ring-white/5">
                <div className="flex flex-col select-none z-20 bg-panelDark border-b border-borderDark">
                    <div className="h-10 flex items-center justify-between px-6">
                        <div className="flex items-center gap-4">
                            <div className="text-gray-500 text-lg text-white tracking-widest opacity-90">Hitscan Configurator</div>
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
                            <button
                                onClick={() => setShowSettings(true)}
                                disabled={!isConnected}
                                className="text-gray-400 hover:text-white cursor-pointer transition-colors p-1 disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Settings"
                            >
                                <Icons.Settings />
                            </button>
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
                                    className={`h-full flex items-center text-xs font-bold tracking-wide transition-all duration-300 relative ${activeTab === tab ? 'text-white' : 'text-gray-500 hover:text-gray-300'
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
                            <span className={`text-[10px] ${isSyncing ? 'text-yellow-400' : 'text-gray-500'} max-w-40 text-right truncate`} title={statusMessage}>
                                {isSyncing ? 'Syncing...' : statusMessage}
                            </span>

                            {isConnected && connectionMode && (
                                <span
                                    className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border [&_svg]:w-3 [&_svg]:h-3 ${
                                        connectionMode === ConnectionMode.WIRED
                                            ? 'border-statusInfo/40 text-statusInfo'
                                            : 'border-statusSuccess/40 text-statusSuccess'
                                    }`}
                                    title={connectionMode === ConnectionMode.WIRED ? 'Connected directly via USB cable' : 'Connected via 2.4 GHz dongle'}
                                >
                                    {connectionMode === ConnectionMode.WIRED
                                        ? <Icons.Wired />
                                        : <Icons.Wireless />}
                                    {connectionMode === ConnectionMode.WIRED ? 'Wired' : 'Wireless'}
                                </span>
                            )}

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
                    {activeTab === 'Key Configuration' && <KeyConfigurationView config={config} updateConfig={(k, v) => updateKeyConfig(k, v)} />}
                    {activeTab === 'Performance' && <PerformanceView config={config} updateConfig={(k, v) => updatePerformanceConfig(k, v)} isDongle={isDongle} />}
                </div>

            </div>

            <SettingsPanel
                show={showSettings}
                onClose={() => setShowSettings(false)}
                deviceInfo={deviceInfo}
                onDfuStart={() => { WebHIDService.dfuInProgress = true; }}
                onDfuEnd={() => { WebHIDService.dfuInProgress = false; }}
            />
        </div>
    );
}

export default App;
