/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bgDark: '#0a0a0a',
        panelDark: '#141414',
        inputDark: '#1a1a1a',
        borderDark: '#2a2a2a',
        accent: '#ffffff',
        textGray: '#888888',
        statusSuccess: '#34d399', // Emerald 400
        statusDanger: '#f87171',  // Red 400
        statusInfo: '#60a5fa',    // Blue 400
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      }
    }
  },
  plugins: [],
}
