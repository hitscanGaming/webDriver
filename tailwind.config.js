/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bgDark: '#0a0a0a',
        panelDark: '#141414',
        inputDark: '#1a1a1a',
        borderDark: '#2a2a2a',
        accent: '#ffffff',
        textGray: '#888888',
        statusSuccess: '#34d399',
        statusDanger: '#f87171',
        statusInfo: '#60a5fa',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideInRight: {
          from: { opacity: '0', transform: 'translateX(20px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};
