import React from 'react';
import { Icons } from './Icons';

export const ToggleSwitch = ({ checked, onChange }) => (
    <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-5 rounded-full relative transition-colors duration-200 focus:outline-none ${checked ? 'bg-white' : 'bg-gray-600'
            }`}
    >
        <div
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-black shadow-md transform transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'
                }`}
        />
    </button>
);

export const CustomSelect = ({ value, options, onChange, width = "w-full" }) => (
    <div className={`relative group ${width}`}>
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full appearance-none bg-inputDark text-gray-200 text-xs border border-gray-700 rounded px-3 py-2 pr-8 focus:outline-none focus:border-gray-500 cursor-pointer hover:border-gray-600"
        >
            {options.map((opt) => (
                <option key={opt} value={opt}>
                    {opt}
                </option>
            ))}
        </select>
        <div className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-500 pointer-events-none">
            <Icons.ChevronDown />
        </div>
    </div>
);

export const RadioGroup = ({ options, selected, onChange, label, layout = "horizontal" }) => (
    <div className="flex flex-col gap-2">
        {label && <span className="text-gray-400 text-xs font-bold mb-2 block">{label}</span>}
        <div className={`flex ${layout === "horizontal" ? "gap-8" : "gap-4"}`}>
            {options.map((opt) => (
                <label key={opt} className="flex flex-col items-center gap-2 cursor-pointer group">
                    <div className="relative flex items-center justify-center">
                        <input
                            type="radio"
                            className="peer appearance-none w-4 h-4 border-2 border-gray-500 rounded-full checked:border-white checked:bg-transparent transition-all"
                            checked={String(selected) === String(opt)}
                            onChange={() => onChange(opt)}
                        />
                        <div className={`absolute w-2 h-2 bg-white rounded-full opacity-0 peer-checked:opacity-100 transition-opacity`}></div>
                    </div>
                    <span className={`text-xs ${String(selected) === String(opt) ? 'text-white' : 'text-gray-500'} font-medium`}>{opt}</span>
                </label>
            ))}
        </div>
    </div>
);
