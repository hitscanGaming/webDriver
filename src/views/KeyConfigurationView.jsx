import React from 'react';
import { Icons } from '../components/Icons';
import { MouseSVG } from '../components/MouseSVG';
import { ToggleSwitch, CustomSelect } from '../components/UI';

export const KeyConfigurationView = ({ config, updateConfig }) => {
    const { keyConfig: settings } = config;

    const keys = [
        { id: 1, label: 'Left Click' },
        { id: 2, label: 'Right Click' },
        { id: 3, label: 'Middle Click' },
        { id: 4, label: 'Forward' },
        { id: 5, label: 'Back' },
        { id: 6, label: 'DPI Loop' },
    ];

    return (
        <div className="flex flex-col h-full animate-[slideInRight_0.3s_ease-out]">
            <div className="flex flex-1 gap-0 px-8 pt-4 pb-0">
                <div className="flex-1 flex flex-col justify-center gap-2">
                    {keys.map((key) => (
                        <div key={key.id} className="flex items-center gap-4">
                            <div className="w-6 h-6 rounded-full bg-inputDark border border-gray-700 flex items-center justify-center text-gray-400 text-xs font-bold shadow-inner">
                                {key.id}
                            </div>
                            <div className="flex-1 bg-inputDark rounded px-4 py-2 flex justify-between items-center border border-gray-800 hover:border-gray-600 transition-colors cursor-pointer group shadow-sm">
                                <span className="text-gray-300 text-xs font-medium">{key.label}</span>
                                <div className="text-gray-600 group-hover:text-gray-400"><Icons.ChevronDown /></div>
                            </div>
                        </div>
                    ))}
                </div>
                <div className="flex-1 flex items-center justify-center relative">
                    <div className="transform scale-120">
                        <MouseSVG showNumbers={true} />
                    </div>
                </div>
            </div>

            <div className="border-t border-borderDark bg-[#0d0d0d] px-8 pb-8 pt-0 flex gap-8">
                <div className="flex-1 bg-panelDark rounded-lg p-5 grid grid-cols-[auto_1fr] gap-x-8 gap-y-4 items-center border border-borderDark shadow-lg">
                    <span className="text-gray-400 text-xs font-medium">Motion Sync</span>
                    <div className="flex justify-end"><ToggleSwitch checked={settings.motionSync} onChange={(v) => updateConfig('motionSync', v)} /></div>

                    <span className="text-gray-400 text-xs font-medium">Debounce Time</span>
                    <div className="flex justify-end w-full">
                        <CustomSelect
                            value={settings.debounceTime}
                            options={['0 ms', '2 ms', '4 ms', '8 ms', '16 ms']}
                            onChange={(v) => updateConfig('debounceTime', v)}
                        />
                    </div>

                    <span className="text-gray-400 text-xs font-medium">Auto Sleep</span>
                    <div className="flex gap-4 items-center justify-end w-full">
                        <ToggleSwitch checked={settings.autoSleep} onChange={(v) => updateConfig('autoSleep', v)} />
                        <div className="w-24">
                            <CustomSelect
                                value={settings.sleepTime}
                                options={['1 min', '5 min', '10 min', 'Never']}
                                onChange={(v) => updateConfig('sleepTime', v)}
                                width="w-24"
                            />
                        </div>
                    </div>
                </div>

                <div className="flex-1 bg-panelDark rounded-lg p-5 flex flex-col justify-between border border-borderDark shadow-lg">
                    <span className="text-gray-400 text-xs font-bold mb-2">Current Profile</span>
                    <CustomSelect value={settings.profile} options={['Profile 1 (Onboard)', 'Profile 2', 'Profile 3']} onChange={(v) => updateConfig('profile', v)} />

                    <div className="flex gap-3 mt-4">
                        <button className="flex-1 flex items-center justify-center gap-2 bg-transparent border border-gray-700 hover:border-gray-500 hover:bg-gray-800 text-gray-300 text-xs py-2 rounded transition-all">
                            Import Config <Icons.Download />
                        </button>
                        <button className="flex-1 flex items-center justify-center gap-2 bg-transparent border border-gray-700 hover:border-gray-500 hover:bg-gray-800 text-gray-300 text-xs py-2 rounded transition-all">
                            Export Config <Icons.Upload />
                        </button>
                    </div>

                    <button className="w-full flex items-center justify-center gap-2 bg-transparent border border-gray-700 hover:border-gray-500 hover:bg-gray-800 text-gray-300 text-xs py-2 rounded mt-2 transition-all">
                        Factory Reset <Icons.RotateCcw />
                    </button>


                </div>
            </div>
        </div>
    );
};
