/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,jsx,ts,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        'aria-bg': '#161616',
        'aria-surface': '#1e1e1e',
        'aria-surface2': '#252525',
        'aria-border': '#2a2a2a',
        'aria-border-hover': '#333333',
        'aria-text': '#c8c8c8',
        'aria-text-dim': '#555555',
        'aria-text-bright': '#f0f0f0',
        'aria-accent': '#4f9cf9',
        'aria-orange': '#f97316',
        'aria-green': '#22c55e',
        'aria-red': '#ef4444',
        'aria-yellow': '#eab308',
        'aria-purple': '#a78bfa',
        'aria-chrome': '#1a1a1a'
      },
      fontFamily: {
        sans: ['DM Sans', 'sans-serif'],
        mono: ['DM Mono', 'monospace']
      }
    }
  },
  plugins: []
};
