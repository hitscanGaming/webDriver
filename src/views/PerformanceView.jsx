import React from 'react';
import { WebHIDService } from '../services/WebHIDService';
import { ToggleSwitch, RadioGroup } from '../components/UI';

export const PerformanceView = ({ config, updateConfig, isDongle }) => {
    const { performance: settings } = config;
    const { dpiStages, dpis, pollingRate, lod, ripple, angleSnapping } = settings;

    const handleDpiChange = (id, newValue) => {
        const val = Math.min(26000, Math.max(50, parseInt(newValue) || 50));
        const updatedDpis = dpis.map(d => d.id === id ? { ...d, value: val } : d);
        updateConfig('dpis', updatedDpis);
    };

    const handleDpiCommit = async (id, newValue) => {
        const val = Math.min(26000, Math.max(50, parseInt(newValue) || 50));
        console.log(`[HID] Committing DPI ${id}: ${val}`);
        try {
            await WebHIDService.setConfig('motion', `cpi_stage_${id}`, val);
            const activeDpi = dpis.find(d => d.active);
            if (activeDpi && activeDpi.id === id) {
                await WebHIDService.setConfig('motion', 'cpi', val);
            }
        } catch (e) {
            console.error("DPI Change Error:", e);
        }
    };

    const toggleDpi = async (id) => {
        const updatedDpis = dpis.map(d => ({ ...d, active: d.id === id }));
        updateConfig('dpis', updatedDpis);

        try {
            await WebHIDService.setConfig('motion', 'cpi_stage_active', id);
            const stage = dpis.find(d => d.id === id);
            if (stage) await WebHIDService.setConfig('motion', 'cpi', stage.value);
        } catch (e) {
            console.error("Toggle DPI Error:", e);
        }
    }

    const handlePollingRate = async (rate) => {
        updateConfig('pollingRate', rate);
        const val = parseInt(rate);
        try {
            await WebHIDService.setConfig('motion', 'poll_esb', val);
            await WebHIDService.setConfig('motion', 'poll_usb', val);
        } catch (e) { console.error("Polling Rate Error", e); }
    };

    const handleLOD = async (valStr) => {
        updateConfig('lod', valStr);
        const val = valStr === '1mm' ? 1 : 2;
        try {
            await WebHIDService.setConfig('motion', 'lod', val);
        } catch (e) { console.error("LOD Error", e); }
    };

    const handleRipple = async (val) => {
        updateConfig('ripple', val);
        try {
            await WebHIDService.setConfig('motion', 'ripple_control', val ? 1 : 0);
        } catch (e) { console.error("Ripple Error", e); }
    }

    const handleAngleSnapping = async (val) => {
        updateConfig('angleSnapping', val);
        try {
            await WebHIDService.setConfig('motion', 'angle_snap', val ? 1 : 0);
        } catch (e) { console.error("Angle Snap Error", e); }
    }

    return (
        <div className="flex flex-col h-full animate-[slideInRight_0.3s_ease-out] px-10 py-8">

            {/* DPI Header */}
            <div className="flex justify-between items-center mb-8">
                <h2 className="text-gray-200 font-bold text-sm">DPI Stage Settings</h2>
                <div className="flex items-center gap-3">
                </div>
            </div>

            {/* DPI Slider List */}
            <div className="flex flex-col gap-7 mb-10 flex-1">
                {dpis.slice(0, dpiStages).map((dpi) => (
                    <div key={dpi.id} className={`flex items-center gap-5 ${!dpi.active ? 'opacity-40 grayscale' : ''} transition-all duration-300`}>
                        {/* Color Indicator/Toggle */}
                        <div
                            onClick={() => toggleDpi(dpi.id)}
                            className={`w-4 h-4 rounded-sm cursor-pointer shadow-sm ${dpi.active ? dpi.color : 'bg-gray-700'}`}
                        ></div>

                        <span className="text-gray-400 text-xs w-10 font-medium">DPI {dpi.id}</span>

                        {/* Slider */}
                        <div className="flex-1 relative h-6 flex items-center group">
                            <input
                                type="range"
                                min="50"
                                max="26000"
                                step="50"
                                value={dpi.value}
                                onChange={(e) => handleDpiChange(dpi.id, e.target.value)}
                                onMouseUp={(e) => handleDpiCommit(dpi.id, e.target.value)}
                                onTouchEnd={(e) => handleDpiCommit(dpi.id, e.target.value)}
                                className="w-full h-[3px] bg-gray-700 rounded-lg appearance-none cursor-pointer outline-none"
                            />
                            <span className="absolute left-0 top-5 text-[10px] text-gray-600">50</span>
                            <span className="absolute right-0 top-5 text-[10px] text-gray-600">26000</span>
                        </div>

                        {/* Input Field */}
                        <input
                            type="number"
                            min="50"
                            max="26000"
                            step="50"
                            value={dpi.value}
                            onChange={(e) => handleDpiChange(dpi.id, e.target.value)}
                            onBlur={(e) => handleDpiCommit(dpi.id, e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    handleDpiCommit(dpi.id, e.currentTarget.value);
                                    e.currentTarget.blur();
                                }
                            }}
                            className="bg-inputDark border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 w-16 text-center focus:outline-none focus:border-gray-500 font-mono"
                        />
                    </div>
                ))}
            </div>

            {/* Bottom Function Area */}
            <div className="grid grid-cols-2 gap-8 h-40">
                {/* Polling Rate */}
                <div className="bg-[#0b0b0b] border border-borderDark rounded-lg p-6 flex flex-col items-center justify-center gap-5 shadow-lg">
                    <span className="text-[#d4d4d4] text-xs font-bold tracking-wide">Polling Rate (Hz)</span>
                    <RadioGroup
                        options={isDongle ? ['125', '250', '500', '1000', '2000', '4000', '8000'] : ['125', '250', '500', '1000']}
                        selected={pollingRate}
                        onChange={handlePollingRate}
                    />
                </div>

                {/* LOD & Enhancement Features */}
                <div className="bg-[#0b0b0b] border border-borderDark rounded-lg p-6 flex items-center justify-between px-8 shadow-lg">
                    <RadioGroup
                        label="LOD"
                        options={['1mm', '2mm']}
                        selected={lod}
                        onChange={handleLOD}
                        layout="vertical"
                    />
                    <div className="h-full w-[1px] bg-gray-800 mx-4"></div>
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between w-44">
                            <span className="text-gray-400 text-xs font-medium">Ripple Control</span>
                            <ToggleSwitch checked={ripple} onChange={handleRipple} />
                        </div>
                        <div className="flex items-center justify-between w-44">
                            <span className="text-gray-400 text-xs font-medium">Angle Snapping</span>
                            <ToggleSwitch checked={angleSnapping} onChange={handleAngleSnapping} />
                        </div>
                    </div>
                </div>
            </div>

        </div>
    );
};
