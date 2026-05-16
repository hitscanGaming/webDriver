import React, { useState, useEffect, useCallback } from 'react';
import { WebHIDService } from './services/WebHIDService';
import { Icons } from './components/Icons';
import { MainView } from './views/MainView';
import { KeyConfigurationView } from './views/KeyConfigurationView';
import { PerformanceView } from './views/PerformanceView';

function App() {
    const [activeTab, setActiveTab] = useState('Main');
    const tabs = ['Main', 'Key Configuration', 'Performance'];

    // WebHID State
    const [device, setDevice] = useState(null);
    const [isDongle, setIsDongle] = useState(false);
    const [statusMessage, setStatusMessage] = useState('Mouse not connected.');
    const [isSyncing, setIsSyncing] = useState(false);
    const [batteryLevel, setBatteryLevel] = useState(null);

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

            console.log("[App] Fetching Battery level...");
            const batLevel = await WebHIDService.getConfig('battery_meas', 'bat_level');
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
            if (!device) {
                setDevice(connectedDevice.device);
                setIsDongle(connectedDevice.isDongle);
                fetchSettings();
            }
        } else {
            if (device) {
                setDevice(null);
                setStatusMessage('Mouse Disconnected.');
            }
        }
    }, [device]);

    useEffect(() => {
        pollConnectionStatus();
        const intervalId = setInterval(pollConnectionStatus, 5000);
        return () => clearInterval(intervalId);
    }, [pollConnectionStatus]);

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
                console.log("[App] Reading Device Info...");
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
        </div>
    );
}

export default App;
