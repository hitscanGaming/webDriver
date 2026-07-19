import { Icons } from '../components/Icons.jsx';
import { MouseSVG } from '../components/MouseSVG.jsx';
import { ToggleSwitch, CustomSelect } from '../components/UI.jsx';
import { WebHIDService } from '../services/WebHIDService.js';
import {
  exportProfile,
  importProfile,
  profileToBlob,
  downloadBlob,
  pickFile,
  readFileAsJson,
} from '../services/ProfileIO.js';

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

export const KeyConfigurationView = ({
  config,
  updateConfig,
  onProtocolError,
  onResync,
  isWiredMouse,
}) => {
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

  const handleProfileChange = async (label) => {
    // Firmware active_slot is informational only in PR5 (slot rotation
    // deferred); the wire SET still persists the selection so a future
    // PR can pick it up.
    updateConfig('profile', label);
    const m = /Profile (\d+)/.exec(label);
    const slot = m ? parseInt(m[1], 10) - 1 : 0;
    await commitSet('Active profile', 'profile', 'active_slot', slot);
  };

  const handleExport = async () => {
    try {
      const { blob: profileObj, failures } = await exportProfile();
      if (failures.length) {
        console.warn('[Profile] Export had partial failures:', failures);
      }
      const filename = `hitscan-profile-${new Date().toISOString().slice(0, 10)}.json`;
      downloadBlob(profileToBlob(profileObj), filename);
    } catch (e) {
      reportError('Export Config', e);
    }
  };

  const handleImport = async () => {
    try {
      const file = await pickFile();
      const json = await readFileAsJson(file);
      const { applied, failures } = await importProfile(json);
      console.log(`[Profile] Imported ${applied.length} options`, applied);
      if (failures.length) {
        console.warn('[Profile] Import failures:', failures);
        reportError('Import Config', { message: `${failures.length} failures (see console)` });
      }
      // importProfile writes straight to the device and never touches React
      // state, so every imported control would keep rendering its pre-import
      // value until the page was reloaded. Read the device back instead of
      // mirroring the JSON locally -- that also surfaces any option the
      // firmware clamped or rejected.
      if (onResync) {
        console.log('[Profile] Re-syncing UI after import.');
        await onResync();
      }
    } catch (e) {
      reportError('Import Config', e);
    }
  };

  const handleFactoryReset = async () => {
    const ok = window.confirm(
      'Factory reset will erase all customizations on this profile and reboot the device. Continue?'
    );
    if (!ok) return;
    // The device erases its settings and then warm-reboots, so the link drops
    // by design. A missing SUCCESS response is therefore not evidence of
    // failure -- the reset has already happened by the time the reply would be
    // sent. Reporting an error here made a working reset look broken.
    try {
      await WebHIDService.setConfig('profile', 'factory_reset_active', 1);
    } catch (e) {
      console.log('[Profile] Link dropped during factory reset (expected):', e.message);
    }
    console.log('[Profile] Factory reset sent; device is rebooting.');

    // Wired: the mouse IS the HID device, so the reset reboot tears the
    // handle down and USB re-enumerates it. The connect listener re-syncs on
    // its own -- syncing here would only poll a dead handle, and since
    // getConfig times out rather than throwing, that cost ~48 s of apparent
    // hang.
    //
    // Wireless: the browser holds the dongle, which stays enumerated across
    // the mouse's reboot. No HID event fires, so this is the only thing that
    // refreshes the UI. Wait for the mouse to come back (1.5 s reboot delay +
    // boot + ESB re-association).
    if (isWiredMouse) {
      console.log('[Profile] Wired: awaiting USB re-enumeration to re-sync.');
      // The handle we hold dies with the reboot. Drop it now so the resync
      // re-acquires the re-enumerated device instead of issuing transfers
      // against a dead one.
      WebHIDService.forgetDevice();
      // Belt and braces: the connect listener should fire on re-enumeration,
      // but it has proven unreliable here. Re-read once the device has had
      // time to come back. fetchSettings no-ops on a closed handle, so this
      // is cheap if the listener already did the work.
      if (onResync) {
        await new Promise((r) => setTimeout(r, 6000));
        console.log('[Profile] Wired fallback re-sync after reset.');
        await onResync();
      }
      return;
    }
    if (onResync) {
      await new Promise((r) => setTimeout(r, 4000));
      console.log('[Profile] Re-syncing UI after reset reboot.');
      await onResync();
    }
  };

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
            onChange={handleProfileChange}
          />

          <div className="flex gap-3 mt-4">
            <button
              onClick={handleImport}
              className="flex-1 flex items-center justify-center gap-2 bg-transparent border border-gray-700 hover:border-gray-500 hover:bg-gray-800 text-gray-300 text-xs py-2 rounded transition-all"
            >
              Import Config <Icons.Download />
            </button>
            <button
              onClick={handleExport}
              className="flex-1 flex items-center justify-center gap-2 bg-transparent border border-gray-700 hover:border-gray-500 hover:bg-gray-800 text-gray-300 text-xs py-2 rounded transition-all"
            >
              Export Config <Icons.Upload />
            </button>
          </div>

          <button
            onClick={handleFactoryReset}
            className="w-full flex items-center justify-center gap-2 bg-transparent border border-gray-700 hover:border-gray-500 hover:bg-gray-800 text-gray-300 text-xs py-2 rounded mt-2 transition-all"
          >
            Factory Reset <Icons.RotateCcw />
          </button>
        </div>
      </div>
    </div>
  );
};
