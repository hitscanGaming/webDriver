import React from 'react';
import { MouseSVG } from '../components/MouseSVG';

export const MainView = () => (
    <div className="flex flex-col items-center justify-center h-full animate-[fadeIn_0.5s_ease-out]">
        <div className="transform scale-150">
            <MouseSVG />
        </div>
    </div>
);
