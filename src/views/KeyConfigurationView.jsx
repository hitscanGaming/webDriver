import { Icons } from '../components/Icons.jsx';
import { MouseSVG } from '../components/MouseSVG.jsx';
import { ToggleSwitch, CustomSelect } from '../components/UI.jsx';
import { WebHIDService } from '../services/WebHIDService.js';

// Sleep Time dropdown labels and their whole-second values. Shared with
// App.jsx, which reverse-maps the value read back from power_cfg/sleep_time.
export const SLEEP_TIME_OPTIONS = ['10 s', '30 s', '1 min', '5 min', '10 min'];
export const SLEEP_TIME_TO_SEC = {
  '10 s': 10,
  '30 s': 30,
  '1 min': 60,
  '5 min': 300,
  '10 min': 600,
};

export const KeyConfigurationView = ({ config, updateConfig, onProtocolError }) => {
  const { keyConfig: settings } = config;

  const reportError = (label, err) => {
    const status = WebHIDService.lastStatus;
    const reason = err ? err.message : WebHIDService.statusToMessage(status);
    console.error(`[HID] ${label} failed: ${reason}`);
    if (onProtocolError) onProtocolError(label, reason);
  };

  const commitSet = async (label, module, option, value) => {
    try {
      const ok = await WebHIDService.setConfig(module, option, value);
      if (!ok) reportError(label, null);
      return ok;
    } catch (e) {
      reportError(label, e);
      return false;
    }
  };

  const handleMotionSync = async (val) => {
    updateConfig('motionSync', val);
    await commitSet('Motion Sync', 'motion/paw3395', 'motion_sync', val ? 1 : 0);
  };

  const handleDebounceTime = async (label) => {
    updateConfig('debounceTime', label);
    const ms = parseInt(label, 10) || 0;
    await commitSet('Debounce Time', 'buttons_cfg', 'debounce_ms', ms);
  };

  // Sleep Time drives the firmware power manager's system-off timeout via the
  // power_cfg config-channel module. The dropdown label maps to whole seconds
  // (e.g. "30 s" -> 30, "5 min" -> 300).
  const handleSleepTime = async (label) => {
    updateConfig('sleepTime', label);
    await commitSet('Sleep Time', 'power_cfg', 'sleep_time', SLEEP_TIME_TO_SEC[label] ?? 60);
  };

  // Assignable actions -> firmware wire codes (byte per key).
  const ACTIONS = [
    { label: 'Left Click', code: 1 },
    { label: 'Right Click', code: 2 },
    { label: 'Middle Click', code: 3 },
    { label: 'Back', code: 4 },
    { label: 'Forward', code: 5 },
    { label: 'DPI Loop', code: 9 },
    { label: 'Disabled', code: 0 },
  ];
  const actionOptions = ACTIONS.map((a) => a.label);
  const actionLabel = (code) => ACTIONS.find((a) => a.code === code)?.label ?? `Action ${code}`;
  const codeFromLabel = (label) => ACTIONS.find((a) => a.label === label)?.code ?? -1;

  const handleKeymap = async (btnIdx, label) => {
    const code = codeFromLabel(label);
    if (code < 0) return;
    const newKeymap = [...settings.keymap];
    newKeymap[btnIdx] = code;
    // At least one button must remain mapped to Left Click (code 1).
    if (!newKeymap.includes(1)) {
      alert('At least one button must be mapped to Left Click.');
      return;
    }
    updateConfig('keymap', newKeymap);
    await commitSet(`Keymap btn ${btnIdx + 1}`, 'buttons_cfg', `keymap_btn_${btnIdx + 1}`, code);
  };

  // Physical button positions 1..6. All are remappable; labels are the
  // default function at each position.
  const keys = [
    { id: 1, label: 'Left Click' },
    { id: 2, label: 'Right Click' },
    { id: 3, label: 'Middle Click' },
    { id: 4, label: 'Back' },
    { id: 5, label: 'Forward' },
    { id: 6, label: 'DPI Loop' },
  ];

  return (
    <div className="flex flex-col h-full animate-[slideInRight_0.3s_ease-out]">
      <div className="flex flex-1 gap-0 px-8 pt-4 pb-0">
        <div className="flex-1 flex flex-col justify-center gap-2">
          {keys.map((key, idx) => (
            <div key={key.id} className="flex items-center gap-4">
              <div className="w-6 h-6 rounded-full bg-inputDark border border-gray-700 flex items-center justify-center text-gray-400 text-xs font-bold shadow-inner">
                {key.id}
              </div>
              <div className="flex-1 flex items-center gap-2">
                <div className="flex-1">
                  <CustomSelect
                    value={actionLabel(settings.keymap[idx] ?? 0)}
                    options={actionOptions}
                    onChange={(v) => handleKeymap(idx, v)}
                  />
                </div>
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
          <div className="flex justify-end">
            <ToggleSwitch checked={settings.motionSync} onChange={handleMotionSync} />
          </div>

          <span className="text-gray-400 text-xs font-medium">Debounce Time</span>
          <div className="flex justify-end w-full">
            <CustomSelect
              value={settings.debounceTime}
              options={['0 ms', '2 ms', '4 ms', '8 ms', '16 ms']}
              onChange={handleDebounceTime}
            />
          </div>

          <span className="text-gray-400 text-xs font-medium">Sleep Time</span>
          <div className="flex justify-end w-full">
            <CustomSelect
              value={settings.sleepTime}
              options={SLEEP_TIME_OPTIONS}
              onChange={handleSleepTime}
            />
          </div>
        </div>

        <div className="flex-1 bg-panelDark rounded-lg p-5 flex flex-col justify-between border border-borderDark shadow-lg">
          <span className="text-gray-400 text-xs font-bold mb-2">Current Profile</span>
          <CustomSelect
            value={settings.profile}
            options={['Profile 1 (Onboard)', 'Profile 2', 'Profile 3']}
            onChange={(v) => updateConfig('profile', v)}
          />

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
