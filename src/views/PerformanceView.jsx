import { ToggleSwitch, RadioGroup } from '../components/UI.jsx';
import { WebHIDService } from '../services/WebHIDService.js';

export const PerformanceView = ({ config, updateConfig, onProtocolError }) => {
  const { performance: settings } = config;
  const { dpiStages, dpis, pollingRate, lod, ripple, angleSnapping } = settings;

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

  const handleDpiChange = (id, newValue) => {
    const val = Math.min(26000, Math.max(50, parseInt(newValue) || 50));
    const updatedDpis = dpis.map((d) => (d.id === id ? { ...d, value: val } : d));
    updateConfig('dpis', updatedDpis);
  };

  const handleDpiCommit = async (id, newValue) => {
    const val = Math.min(26000, Math.max(50, parseInt(newValue) || 50));
    console.log(`[HID] Committing DPI ${id}: ${val}`);
    const ok = await commitSet(`DPI stage ${id}`, 'motion', `cpi_stage_${id}`, val);
    if (!ok) return;
    const activeDpi = dpis.find((d) => d.active);
    if (activeDpi && activeDpi.id === id) {
      await commitSet(`DPI active`, 'motion', 'cpi', val);
    }
  };

  const toggleDpi = async (id) => {
    const updatedDpis = dpis.map((d) => ({ ...d, active: d.id === id }));
    updateConfig('dpis', updatedDpis);

    const ok = await commitSet(`DPI stage select`, 'motion', 'cpi_stage_active', id);
    if (!ok) return;
    const stage = dpis.find((d) => d.id === id);
    if (stage) await commitSet(`DPI active`, 'motion', 'cpi', stage.value);
  };

  const handlePollingRate = async (rate) => {
    updateConfig('pollingRate', rate);
    const val = parseInt(rate);
    const ok = await commitSet(`Polling rate (ESB)`, 'polling', 'poll_esb', val);
    if (!ok) return;
    await commitSet(`Polling rate (USB)`, 'polling', 'poll_usb', val);
  };

  const handleLOD = async (valStr) => {
    updateConfig('lod', valStr);
    const val = valStr === '1mm' ? 1 : 2;
    await commitSet(`LOD`, 'motion', 'lod', val);
  };

  const handleRipple = async (val) => {
    updateConfig('ripple', val);
    await commitSet(`Ripple control`, 'motion', 'ripple_control', val ? 1 : 0);
  };

  const handleAngleSnapping = async (val) => {
    updateConfig('angleSnapping', val);
    await commitSet(`Angle snapping`, 'motion', 'angle_snap', val ? 1 : 0);
  };

  return (
    <div className="flex flex-col h-full animate-[slideInRight_0.3s_ease-out] px-10 py-8">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-gray-200 font-bold text-sm">DPI Stage Settings</h2>
        <div className="flex items-center gap-3"></div>
      </div>

      <div className="flex flex-col gap-7 mb-10 flex-1">
        {dpis.slice(0, dpiStages).map((dpi) => (
          <div
            key={dpi.id}
            className={`flex items-center gap-5 ${!dpi.active ? 'opacity-40 grayscale' : ''} transition-all duration-300`}
          >
            <div
              onClick={() => toggleDpi(dpi.id)}
              className={`w-4 h-4 rounded-sm cursor-pointer shadow-sm ${dpi.active ? dpi.color : 'bg-gray-700'}`}
            ></div>

            <span className="text-gray-400 text-xs w-10 font-medium">DPI {dpi.id}</span>

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
                  e.currentTarget.blur();
                }
              }}
              className="bg-inputDark border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 w-16 text-center focus:outline-none focus:border-gray-500 font-mono"
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-8 h-40">
        <div className="bg-[#0b0b0b] border border-borderDark rounded-lg p-6 flex flex-col items-center justify-center gap-5 shadow-lg">
          <span className="text-[#d4d4d4] text-xs font-bold tracking-wide">Polling Rate (Hz)</span>
          <RadioGroup
            options={['125', '250', '500', '1000', '2000', '4000', '8000']}
            selected={pollingRate}
            onChange={handlePollingRate}
          />
        </div>

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
