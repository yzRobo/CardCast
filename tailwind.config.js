// tailwind.config.js
module.exports = {
  content: [
    "./index.html",
    "./pokemon-match-control.html",
    "./public/**/*.{html,js}",
    "./overlays/**/*.html",
    "./src/**/*.js"
  ],
  theme: {
    extend: {
      animation: {
        'float': 'float 6s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'shimmer': 'shimmer 2s infinite',
        'gradient-shift': 'gradient-shift 15s ease infinite',
        'gradient-border': 'gradient-border 15s ease infinite',
        'slide-in': 'slide-in 0.3s ease-out',
        'float-orb': 'float-orb 20s infinite ease-in-out',
        'scale-in': 'scale-in 0.2s ease-out',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-20px)' }
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 20px rgba(129, 140, 248, 0.5)' },
          '50%': { boxShadow: '0 0 40px rgba(129, 140, 248, 0.8)' }
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' }
        },
        'gradient-shift': {
          '0%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
          '100%': { backgroundPosition: '0% 50%' }
        },
        'gradient-border': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' }
        },
        'slide-in': {
          'from': { transform: 'translateX(100%)', opacity: '0' },
          'to': { transform: 'translateX(0)', opacity: '1' }
        },
        'float-orb': {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '33%': { transform: 'translate(30px, -30px) scale(1.1)' },
          '66%': { transform: 'translate(-20px, 20px) scale(0.9)' }
        },
        'scale-in': {
          'from': { transform: 'scale(0.9)', opacity: '0' },
          'to': { transform: 'scale(1)', opacity: '1' }
        }
      },
      backdropBlur: {
        xs: '2px',
      }
    },
  },
  plugins: [require("daisyui")],
  daisyui: {
    themes: [
      {
        cardcast: {
          "primary": "#818cf8",           // Brighter indigo
          "primary-focus": "#6366f1",     // Darker indigo for hover
          "primary-content": "#ffffff",   // White text on primary
          
          "secondary": "#c084fc",          // Vibrant purple
          "secondary-focus": "#a855f7",   // Darker purple for hover
          "secondary-content": "#ffffff", // White text on secondary
          
          "accent": "#22d3ee",            // Bright cyan
          "accent-focus": "#06b6d4",      // Darker cyan for hover
          "accent-content": "#ffffff",    // White text on accent
          
          "neutral": "#1e293b",           // Slate
          "neutral-focus": "#334155",     // Lighter slate for hover
          "neutral-content": "#f1f5f9",   // Light text on neutral
          
          "base-100": "#0a0e1a",          // Deepest dark background
          "base-200": "#131824",          // Rich dark blue
          "base-300": "#1e2436",          // Subtle blue tint
          "base-content": "#e2e8f0",      // Light gray text
          
          "info": "#60a5fa",              // Bright blue
          "info-content": "#ffffff",      // White text on info
          
          "success": "#34d399",           // Emerald green
          "success-content": "#ffffff",   // White text on success
          
          "warning": "#fbbf24",           // Amber
          "warning-content": "#000000",   // Black text on warning
          
          "error": "#f87171",             // Light red
          "error-content": "#ffffff",     // White text on error
          
          "--rounded-box": "1rem",
          "--rounded-btn": "0.75rem",
          "--rounded-badge": "1.9rem",
          "--animation-btn": "0.25s",
          "--animation-input": "0.2s",
          "--btn-text-case": "uppercase",
          "--btn-focus-scale": "0.95",
          "--border-btn": "1px",
          "--tab-border": "1px",
          "--tab-radius": "0.5rem",
        },
      },
    ],
  },
}