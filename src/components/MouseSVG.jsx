export const MouseSVG = ({ showNumbers = false }) => (
  <div className="relative w-48 h-80 mx-auto select-none">
    <svg viewBox="0 0 200 360" className="w-full h-full drop-shadow-2xl">
      <defs>
        <linearGradient id="mouseGrad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#2a2a2a" />
          <stop offset="50%" stopColor="#1a1a1a" />
          <stop offset="100%" stopColor="#0a0a0a" />
        </linearGradient>
        <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      <path
        d="M50,90 C50,20 150,20 150,90 L150,240 C150,310 50,310 50,240 Z"
        fill="url(#mouseGrad)"
        stroke="#111"
        strokeWidth="1"
      />

      <path d="M50,130 L150,130" stroke="#000" strokeWidth="2" />
      <path d="M100,20 L100,130" stroke="#000" strokeWidth="2" />

      <rect x="92" y="55" width="16" height="35" rx="4" fill="#080808" stroke="#333" strokeWidth="1" />
      <rect x="96" y="60" width="8" height="4" rx="1" fill="#444" />
      <rect x="96" y="68" width="8" height="4" rx="1" fill="#444" />
      <rect x="96" y="76" width="8" height="4" rx="1" fill="#444" />

      <circle cx="100" cy="45" r="1.5" fill="cyan" className="animate-pulse">
        <animate attributeName="opacity" values="0.5;1;0.5" dur="2s" repeatCount="indefinite" />
      </circle>

      <path d="M48,160 L48,185 C45,185 45,160 48,160" fill="#222" stroke="#111" />
      <path d="M48,195 L48,220 C45,220 45,195 48,195" fill="#222" stroke="#111" />

      <text x="100" y="260" textAnchor="middle" fill="#333" fontSize="18" fontWeight="bold" fontFamily="sans-serif">
        X
      </text>
    </svg>

    {showNumbers && (
      <>
        <div className="absolute top-[25%] left-[15%] w-5 h-5 bg-gray-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-gray-500 shadow-lg">1</div>
        <div className="absolute top-[25%] right-[15%] w-5 h-5 bg-gray-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-gray-500 shadow-lg">2</div>
        <div className="absolute top-[18%] left-[50%] transform -translate-x-1/2 w-5 h-5 bg-gray-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-gray-500 shadow-lg">3</div>
        <div className="absolute top-[48%] left-[-8px] w-5 h-5 bg-gray-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-gray-500 shadow-lg">4</div>
        <div className="absolute top-[58%] left-[-8px] w-5 h-5 bg-gray-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-gray-500 shadow-lg">5</div>
        <div className="absolute top-[48%] right-[-25px] flex items-center opacity-70">
          <div className="w-8 h-[1px] border-t border-dashed border-gray-500"></div>
          <div className="w-5 h-5 bg-gray-600 rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-gray-500 shadow-lg ml-1">6</div>
        </div>
      </>
    )}
  </div>
);
